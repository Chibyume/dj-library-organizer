import { randomUUID } from 'node:crypto'
import { mkdir, opendir, realpath, rm, copyFile, chmod } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import Database from 'better-sqlite3'
import type { LibraryDB } from './db'
import type { NativeHelper, Inspection } from './native'
import type {
  XMLCandidate,
  XMLCandidates,
  XMLSummary,
  XMLProgress,
  XMLQuery,
  XMLPage,
  XMLEntry,
  XMLTrackEvidence,
  XMLMatchStatus,
  Track,
} from './shared'

type Parsed = Pick<
  XMLSummary,
  | 'hash'
  | 'size'
  | 'modifiedAt'
  | 'tracks'
  | 'playlists'
  | 'memberships'
  | 'dangling'
  | 'product'
  | 'warnings'
> & { nodes: number }
type Candidate = {
  candidate: XMLCandidate
  stage: string
  raw: string
  parsed: Parsed
  inspection: Inspection
}
type Match = {
  status: XMLMatchStatus
  reason: string
  fileId: string | null
  candidates: string[]
  conflicts: string[]
}
const yieldJob = () => new Promise<void>(resolve => setImmediate(resolve))
const message = (e: unknown) => (e instanceof Error ? e.message : 'Could not import the XML.')

export class Rekordbox {
  private candidates = new Map<string, Candidate>()
  private worker: Worker | null = null
  private abort = false
  private busy = false
  private deadline = 0
  private closed = false
  get running() {
    return this.busy
  }
  private reconcileAgain = false
  private task: Promise<unknown> | null = null
  readonly directory: string
  private session: string
  constructor(
    private db: LibraryDB,
    private helper: NativeHelper,
    private workerPath: string,
    private notify: (progress: XMLProgress) => void
  ) {
    this.directory = path.join(db.directory, 'rekordbox')
    this.session = path.join(this.directory, 'work')
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await rm(this.session, { recursive: true, force: true })
    await mkdir(this.session, { mode: 0o700 })
  }
  cancel() {
    this.abort = true
    void this.worker?.terminate()
  }
  async close() {
    this.closed = true
    this.reconcileAgain = false
    this.cancel()
    await this.task?.catch(() => {})
    await rm(this.session, { recursive: true, force: true })
  }
  private check() {
    if (Date.now() > this.deadline) {
      this.abort = true
      void this.worker?.terminate()
      throw new Error('XML operation exceeded its time limit. Choose a smaller scope or export.')
    }
    if (this.abort) throw new Error('XML operation cancelled. The current snapshot is unchanged.')
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('The XML service is closing.')
    if (this.busy) throw new Error('An XML operation is running. Wait or cancel it first.')
    this.busy = true
    this.abort = false
    this.deadline = Date.now() + 150000
    const task = fn()
    this.task = task
    try {
      return await task
    } catch (e) {
      if (this.abort) {
        this.candidates.clear()
        await rm(this.session, { recursive: true, force: true })
        await mkdir(this.session, { mode: 0o700 })
      }
      this.notify({
        phase: this.abort ? 'cancelled' : 'failed',
        filename: '',
        tracks: 0,
        bytes: 0,
        message: message(e),
      })
      throw e
    } finally {
      this.worker = null
      this.busy = false
      this.task = null
      if (this.reconcileAgain && !this.closed) {
        this.reconcileAgain = false
        void this.reconcile().catch(() => {})
      }
    }
  }
  async find(paths: string[]): Promise<XMLCandidates> {
    return this.exclusive(async () => {
      await rm(this.session, { recursive: true, force: true })
      await mkdir(this.session, { mode: 0o700 })
      this.candidates.clear()
      const found: string[] = [],
        warnings: string[] = [],
        seen = new Set<string>()
      let visited = 0
      const walk = async (p: string, depth: number) => {
        this.check()
        if (++visited > 5000 || found.length >= 20) {
          if (
            !warnings.includes(
              'Folder search stopped at its safety limit; choose a specific XML file if needed.'
            )
          )
            warnings.push(
              'Folder search stopped at its safety limit; choose a specific XML file if needed.'
            )
          return
        }
        let info: Inspection
        try {
          info = await this.helper.inspect(p)
        } catch (e) {
          warnings.push(`${path.basename(p)}: ${message(e)}`)
          return
        }
        if (info.alias || info.package || info.cloudOnly || info.availabilityUnknown) {
          if (depth === 0)
            warnings.push(
              `${path.basename(p)}: choose a locally available ordinary file or folder.`
            )
          return
        }
        const actual = await realpath(p)
        if (path.resolve(p) !== actual) {
          if (depth === 0)
            warnings.push('Symbolic links are not opened. Choose the original file or folder.')
          return
        }
        if (seen.has(actual)) return
        seen.add(actual)
        if (info.regular && path.extname(p).toLowerCase() === '.xml') found.push(p)
        else if (info.directory && depth < 5) {
          for await (const entry of await opendir(p)) {
            if (
              !entry.name.startsWith('.') &&
              !entry.isSymbolicLink() &&
              (entry.isDirectory() ||
                (entry.isFile() && path.extname(entry.name).toLowerCase() === '.xml'))
            )
              await walk(path.join(p, entry.name), depth + 1)
            if (visited > 5000 || found.length >= 20) break
          }
        } else if (info.directory)
          warnings.push('Folder search stops after five levels; choose deeper exports directly.')
      }
      this.notify({
        phase: 'finding',
        filename: '',
        tracks: 0,
        bytes: 0,
        message: 'Finding XML candidates in the selected locations…',
      })
      for (const p of paths) await walk(p, 0)
      const candidates: XMLCandidate[] = []
      for (const source of found) {
        this.check()
        const id = randomUUID()
        const stage = path.join(this.session, id + '.sqlite'),
          raw = path.join(this.session, id + '.xml')
        const info = await this.helper.inspect(source)
        const candidate: XMLCandidate = {
          id,
          path: source,
          filename: path.basename(source),
          modifiedAt: new Date(Number(info.mtime.split(':')[0]) * 1000).toISOString(),
          size: info.size,
          valid: false,
          error: null,
          tracks: 0,
          playlists: 0,
          product: '',
        }
        try {
          const parsed = await this.parse(source, stage, raw, info)
          this.check()
          Object.assign(candidate, {
            valid: true,
            modifiedAt: parsed.modifiedAt,
            tracks: parsed.tracks,
            playlists: parsed.playlists,
            product: parsed.product,
          })
          this.candidates.set(id, {
            candidate,
            stage,
            raw,
            parsed,
            inspection: info,
          })
        } catch (e) {
          await rm(stage, { force: true })
          await rm(raw, { force: true })
          this.check()
          candidate.error = message(e)
        }
        candidates.push(candidate)
      }
      if (!candidates.length)
        warnings.push('No XML exports found. Choose a file or a folder containing an export.')
      this.notify({
        phase: 'completed',
        filename: '',
        tracks: 0,
        bytes: 0,
        message: 'Choose a validated snapshot to import.',
      })
      return { candidates, warnings: warnings.slice(0, 30) }
    })
  }
  private parse(source: string, stage: string, raw: string, expected: Inspection): Promise<Parsed> {
    this.notify({
      phase: 'reading',
      filename: path.basename(source),
      tracks: 0,
      bytes: 0,
      message: 'Validating local XML…',
    })
    return new Promise((resolve, reject) => {
      let settled = false
      const w = (this.worker = new Worker(this.workerPath, {
        workerData: { source, stage, raw, expected },
        resourceLimits: {
          maxOldGenerationSizeMb: 256,
          maxYoungGenerationSizeMb: 32,
        },
      }))
      const finish = (e: Error | null, result?: Parsed) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.worker = null
        void w.terminate()
        e ? reject(e) : resolve(result!)
      }
      const timer = setTimeout(
        () => finish(new Error('XML validation timed out. Try a smaller export.')),
        Math.max(1, Math.min(120000, this.deadline - Date.now()))
      )
      w.on('message', m => {
        if (m.progress)
          this.notify({
            phase: 'reading',
            filename: path.basename(source),
            ...m.progress,
            message: 'Validating local XML…',
          })
        if (m.error) finish(new Error(m.error))
        if (m.result) finish(null, m.result)
      })
      w.on('error', e => finish(new Error(message(e))))
      w.on('exit', code => {
        if (!settled)
          finish(
            new Error(this.abort ? 'XML operation cancelled.' : `XML worker stopped (${code}).`)
          )
      })
    })
  }
  private catalog() {
    const exact = new Map<string, Set<string>>(),
      folded = new Map<string, Set<string>>(),
      historical = new Map<string, Set<string>>()
    const add = (map: Map<string, Set<string>>, p: string, id: string) => {
      let ids = map.get(p)
      if (!ids) map.set(p, (ids = new Set()))
      ids.add(id)
    }
    for (const l of this.db.db
      .prepare('SELECT fileId,path,available FROM locations')
      .iterate() as Iterable<{
      fileId: string
      path: string
      available: number
    }>) {
      const p = path.normalize(l.path).normalize('NFC')
      add(l.available ? exact : historical, p, l.fileId)
      if (l.available) add(folded, p.toLocaleLowerCase('en-US'), l.fileId)
    }
    return { exact, folded, historical }
  }
  private match(
    t: { attrs: string; localPath: string | null; refKind: string },
    catalog: ReturnType<Rekordbox['catalog']>
  ): Match {
    const empty = { fileId: null, candidates: [], conflicts: [] } as Pick<
      Match,
      'fileId' | 'candidates' | 'conflicts'
    >
    if (t.refKind !== 'local')
      return {
        ...empty,
        status: t.refKind === 'nonlocal' ? 'nonlocal' : 'invalid',
        reason:
          t.refKind === 'nonlocal'
            ? 'Nonlocal reference. Audio was not accessed.'
            : 'Invalid file URL. Audio was not accessed.',
      }
    const p = t.localPath!
    let ids = [...(catalog.exact.get(p) || [])]
    if (ids.length > 1)
      return {
        ...empty,
        status: 'ambiguous',
        candidates: ids,
        reason: 'This path identifies multiple catalog file instances.',
      }
    if (!ids.length) {
      ids = [
        ...new Set([
          ...(catalog.historical.get(p) || []),
          ...(catalog.folded.get(p.toLocaleLowerCase('en-US')) || []),
        ]),
      ]
      return {
        ...empty,
        status: ids.length > 1 ? 'ambiguous' : ids.length ? 'possible' : 'unmatched',
        candidates: ids,
        reason: ids.length
          ? 'Historical or case-only path match requires review; no automatic link was made.'
          : 'Path is not in the current discovered catalog. It may be outside your sources, unavailable, or moved.',
      }
    }
    const file = this.db.get(ids[0]!)!
    const attrs = JSON.parse(t.attrs) as Record<string, string>
    const conflicts: string[] = []
    for (const [xml, field] of [
      ['Name', 'title'],
      ['Artist', 'artist'],
      ['Genre', 'genre'],
      ['Tonality', 'key'],
    ] as const) {
      if (
        attrs[xml]?.trim() &&
        file[field]?.trim() &&
        attrs[xml]!.trim().normalize('NFC').toLocaleLowerCase('en-US') !==
          file[field]!.trim().normalize('NFC').toLocaleLowerCase('en-US')
      )
        conflicts.push(`${xml}: XML “${attrs[xml]}” · embedded “${file[field]}”`)
    }
    for (const [xml, value, tolerance] of [
      ['Size', file.size, 0],
      ['TotalTime', file.duration, 2],
      ['AverageBpm', file.bpm, 0.05],
      ['Year', file.year, 0],
    ] as const) {
      const n = Number(attrs[xml])
      if (
        attrs[xml] &&
        Number.isFinite(n) &&
        n > 0 &&
        value !== null &&
        Math.abs(n - value) > tolerance
      )
        conflicts.push(`${xml}: XML ${attrs[xml]} · catalog ${value}`)
    }
    // Size/duration disagreement can mean a replacement at the same path. Never confirm it as the same version.
    const identityConflict = conflicts.some(
      c => c.startsWith('Size:') || c.startsWith('TotalTime:')
    )
    return {
      status: identityConflict ? 'possible' : 'referenced',
      fileId: identityConflict ? null : file.id,
      candidates: identityConflict ? [file.id] : [],
      conflicts,
      reason: identityConflict
        ? 'Exact path has size/duration differences. Version identity needs review.'
        : `Exact catalog path is referenced in this snapshot${file.availability !== 'available' ? `; file is ${file.availability}` : ''}.`,
    }
  }
  private async matchStage(stage: Database.Database, filename: string) {
    const catalog = this.catalog()
    const insert = stage.prepare('INSERT OR REPLACE INTO matches VALUES(?,?,?,?,?,?)')
    let count = 0,
      lastProgress = 0
    stage.exec('BEGIN')
    try {
      let cursor = 0
      while (true) {
        const batch = stage
          .prepare('SELECT rowid AS cursor,* FROM tracks WHERE rowid>? ORDER BY rowid LIMIT 250')
          .all(cursor) as {
          cursor: number
          trackKey: string
          attrs: string
          localPath: string | null
          refKind: string
        }[]
        if (!batch.length) break
        for (const t of batch) {
          cursor = t.cursor
          this.check()
          const m = this.match(t, catalog)
          insert.run(
            t.trackKey,
            m.status,
            m.reason,
            m.fileId,
            JSON.stringify(m.candidates),
            JSON.stringify(m.conflicts)
          )
          if (++count % 250 === 0) {
            if (Date.now() - lastProgress > 250) {
              lastProgress = Date.now()
              this.notify({
                phase: 'matching',
                filename,
                tracks: count,
                bytes: 0,
                message: 'Matching catalog paths and checking metadata differences…',
              })
            }
            await yieldJob()
          }
        }
      }
      stage.exec('COMMIT')
    } catch (e) {
      stage.exec('ROLLBACK')
      throw e
    }
  }
  async import(id: string, onlyChanged = false): Promise<XMLSummary> {
    return this.exclusive(async () => {
      const c = this.candidates.get(id)
      if (!c) throw new Error('Choose a validated XML candidate again; its selection has expired.')
      const current = await this.helper.inspect(c.candidate.path)
      if (
        !current.regular ||
        current.alias ||
        current.cloudOnly ||
        current.availabilityUnknown ||
        ['device', 'inode', 'size', 'mtime', 'ctime'].some(
          key => current[key as keyof Inspection] !== c.inspection[key as keyof Inspection]
        )
      )
        throw new Error(
          'The selected XML changed after validation. Choose it again before importing.'
        )
      const active = this.summary()
      if (onlyChanged && active?.hash === c.parsed.hash && active.sourcePath === c.candidate.path)
        return active
      const stage = new Database(c.stage)
      try {
        await this.matchStage(stage, c.candidate.filename)
      } finally {
        stage.close()
      }
      this.check()
      const rawDestination = path.join(this.directory, c.parsed.hash + '.xml')
      try {
        await copyFile(c.raw, rawDestination, constants.COPYFILE_EXCL)
        await chmod(rawDestination, 0o400)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
      const snapshotId = randomUUID(),
        now = new Date().toISOString(),
        p = c.parsed
      this.db.db.prepare('ATTACH DATABASE ? AS rb_stage').run(c.stage)
      try {
        this.db.db.transaction(() => {
          this.db.db.prepare('UPDATE rb_snapshots SET active=0 WHERE active=1').run()
          this.db.db
            .prepare('INSERT INTO rb_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)')
            .run(
              snapshotId,
              c.candidate.path,
              now,
              p.modifiedAt,
              p.hash,
              p.size,
              p.product,
              p.tracks,
              p.playlists,
              p.memberships,
              p.dangling,
              JSON.stringify(p.warnings),
              now
            )
          for (const table of ['tracks', 'nodes', 'memberships', 'matches'])
            this.db.db
              .prepare(`INSERT INTO rb_${table} SELECT ?,s.* FROM rb_stage.${table} s`)
              .run(snapshotId)
        })()
      } finally {
        this.db.db.exec('DETACH DATABASE rb_stage')
      }
      this.notify({
        phase: 'completed',
        filename: c.candidate.filename,
        tracks: p.tracks,
        bytes: p.size,
        message: 'Snapshot imported. Your manual decisions are preserved.',
      })
      this.candidates.clear()
      await rm(this.session, { recursive: true, force: true })
      await mkdir(this.session, { mode: 0o700 })
      return this.summary()!
    })
  }
  summary(): XMLSummary | null {
    const row = this.db.db.prepare('SELECT * FROM rb_snapshots WHERE active=1').get() as
      | (Omit<XMLSummary, 'counts' | 'nodes' | 'nodeCount' | 'warnings'> & {
          warnings: string
        })
      | undefined
    if (!row) return null
    const counts: XMLSummary['counts'] = {
      referenced: 0,
      possible: 0,
      ambiguous: 0,
      unmatched: 0,
      nonlocal: 0,
      invalid: 0,
      conflict: 0,
    }
    for (const c of this.db.db
      .prepare('SELECT status,COUNT(*) n FROM rb_matches WHERE snapshotId=? GROUP BY status')
      .all(row.id) as { status: XMLMatchStatus; n: number }[])
      counts[c.status] = c.n
    counts.conflict = (
      this.db.db
        .prepare("SELECT COUNT(*) n FROM rb_matches WHERE snapshotId=? AND conflicts!='[]'")
        .get(row.id) as { n: number }
    ).n
    const nodes = this.db.db
      .prepare(
        'SELECT id,parentId,name,type,entries,depth FROM rb_nodes WHERE snapshotId=? ORDER BY ordinal LIMIT 500'
      )
      .all(row.id) as XMLSummary['nodes']
    const nodeCount = (
      this.db.db.prepare('SELECT COUNT(*) n FROM rb_nodes WHERE snapshotId=?').get(row.id) as {
        n: number
      }
    ).n
    return {
      ...row,
      warnings: JSON.parse(row.warnings),
      counts,
      nodes,
      nodeCount,
    }
  }
  private entry(row: any): XMLEntry {
    const tempo = JSON.parse(row.tempo) as Record<string, string>[]
    const cues = JSON.parse(row.cues) as Record<string, string>[]
    return {
      trackKey: row.trackKey,
      localPath: row.localPath,
      status: row.status,
      reason: row.reason,
      fileId: row.fileId,
      attrs: Object.fromEntries(
        Object.entries(JSON.parse(row.attrs) as Record<string, string>).map(([k, v]) => [
          k,
          v.slice(0, 2048),
        ])
      ),
      tempo: tempo.slice(0, 50),
      cues: cues.slice(0, 50),
      tempoCount: tempo.length,
      cueCount: cues.length,
      candidates: JSON.parse(row.candidates),
      conflicts: JSON.parse(row.conflicts),
      playlists: (
        this.db.db
          .prepare(
            'SELECT DISTINCT n.name FROM rb_memberships m JOIN rb_nodes n ON n.snapshotId=m.snapshotId AND n.id=m.nodeId WHERE m.snapshotId=? AND m.trackKey=? ORDER BY n.ordinal LIMIT 100'
          )
          .all(row.snapshotId, row.trackKey) as { name: string }[]
      ).map(p => p.name),
    }
  }
  list(q: XMLQuery): XMLPage {
    const s = this.summary()
    if (!s) return { entries: [], total: 0 }
    const clauses = ['t.snapshotId=?'],
      params: unknown[] = [s.id]
    if (q.status === 'conflict') clauses.push("m.conflicts!='[]'")
    else if (q.status !== 'all') {
      clauses.push('m.status=?')
      params.push(q.status)
    }
    if (q.nodeId) {
      clauses.push(
        'EXISTS(SELECT 1 FROM rb_memberships p WHERE p.snapshotId=t.snapshotId AND p.trackKey=t.trackKey AND p.nodeId=?)'
      )
      params.push(q.nodeId)
    }
    const from =
      ' FROM rb_tracks t JOIN rb_matches m ON m.snapshotId=t.snapshotId AND m.trackKey=t.trackKey WHERE ' +
      clauses.join(' AND ')
    const total = (
      this.db.db.prepare('SELECT COUNT(*) n' + from).get(...params) as {
        n: number
      }
    ).n
    return {
      total,
      entries: this.db.db
        .prepare(
          'SELECT t.*,m.status,m.reason,m.fileId,m.candidates,m.conflicts' +
            from +
            ' ORDER BY t.rowid LIMIT ? OFFSET ?'
        )
        .all(...params, q.limit, q.offset)
        .map(r => this.entry(r)),
    }
  }
  track(id: string): XMLTrackEvidence {
    const s = this.summary()
    const preview = this.db.db
      .prepare(
        'SELECT p.* FROM preview_evidence p JOIN files f ON f.id=p.fileId AND f.signature=p.signature WHERE p.fileId=?'
      )
      .get(id) as
      { status: 'played' | 'failed'; checkedAt: string; error: string | null } | undefined
    const entries = s
      ? this.db.db
          .prepare(
            'SELECT t.*,m.status,m.reason,m.fileId,m.candidates,m.conflicts FROM rb_tracks t JOIN rb_matches m ON m.snapshotId=t.snapshotId AND m.trackKey=t.trackKey WHERE t.snapshotId=? AND (m.fileId=? OR EXISTS(SELECT 1 FROM json_each(m.candidates) WHERE value=?)) LIMIT 100'
          )
          .all(s.id, id, id)
          .map(r => this.entry(r))
      : []
    return {
      snapshot: s
        ? {
            id: s.id,
            sourcePath: s.sourcePath,
            importedAt: s.importedAt,
            modifiedAt: s.modifiedAt,
          }
        : null,
      entries,
      preview: preview?.status || 'untested',
      previewAt: preview?.checkedAt || null,
      previewError: preview?.error || null,
    }
  }
  async reconcile() {
    if (this.busy) {
      this.reconcileAgain = true
      return
    }
    const s = this.summary()
    if (!s) return
    return this.exclusive(async () => {
      const catalog = this.catalog(),
        updates: { key: string; m: Match }[] = []
      let count = 0
      for (const t of this.db.db
        .prepare('SELECT * FROM rb_tracks WHERE snapshotId=?')
        .iterate(s.id) as Iterable<{
        trackKey: string
        attrs: string
        localPath: string | null
        refKind: string
      }>) {
        this.check()
        updates.push({ key: t.trackKey, m: this.match(t, catalog) })
        if (++count % 250 === 0) await yieldJob()
      }
      this.db.db.transaction(() => {
        const insert = this.db.db.prepare(
          'UPDATE rb_matches SET status=?,reason=?,fileId=?,candidates=?,conflicts=? WHERE snapshotId=? AND trackKey=?'
        )
        for (const { key, m } of updates)
          insert.run(
            m.status,
            m.reason,
            m.fileId,
            JSON.stringify(m.candidates),
            JSON.stringify(m.conflicts),
            s.id,
            key
          )
        this.db.db
          .prepare('UPDATE rb_snapshots SET matchedAt=? WHERE id=?')
          .run(new Date().toISOString(), s.id)
      })()
      this.notify({
        phase: 'completed',
        filename: path.basename(s.sourcePath),
        tracks: count,
        bytes: 0,
        message: 'Snapshot references reconciled with the latest scan.',
      })
    })
  }
}

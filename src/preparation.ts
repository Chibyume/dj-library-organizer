import type { Classifier } from './classifier'
import { SYNC_NAMESPACE } from './managed-sync'
import { bestCopy, comparableVersions } from './duplicate-choice'
import { verifyExport } from './export-verification'
import { validateExportXML } from './export-validation'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { LibraryDB } from './db'
import { NativeHelper } from './native'
import { DuplicateHashes, validateAudio, type CatalogFile } from './duplicate-hashes'
import { MUSIC_CATEGORIES } from './shared'
import { within } from './scanner'
import { playlistFiles, IMPORT_GUIDE } from './playlist-export'
import { LibraryReview } from './library-review'
import { managedTrackIDs } from './managed-track-ids'
import {
  managedLibraryXML,
  managedOrganization,
  managedPath,
  type ManagedPracticeTrack,
} from './managed-library-export'
import type { LibraryPage, LibraryQuery } from './shared'
import type { LibraryReviewOverview } from './library-review-types'
import type {
  DuplicateGroup,
  DuplicatePage,
  PreparationItem,
  PreparationPreview,
  PreparationRequest,
  ExportRecord,
} from './preparation-types'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const normalize = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
type Row = CatalogFile & {
  hash: string | null
  hashError: string | null
  classificationHash: string | null
  result: string | null
  acknowledgedHash: string | null
  queued: number
  approval: string | null
  eraYear: number | null
  eraSignature: string | null
  sourceEnabled: number
  sourceStatus: string
}
type Ref = {
  fileId: string
  trackKey: string
  candidates: string
  status: string
  conflicts: string
  attrs: string
  tempo: string
  cues: string
  localPath: string
  playlistReferences: number
}
type Context = {
  rows: Row[]
  refs: Map<string, Ref[]>
  groups: DuplicateGroup[]
  decisions: Map<string, string | null>
  blocked: Map<string, string>
  unchecked: number
  snapshot: { id: string; importedAt: string } | null
}
type Prepared = {
  item: PreparationItem
  fingerprint: string
  row: Row
  reference: Ref | null
}
type Plan = {
  preview: PreparationPreview
  items: Prepared[]
  request: PreparationRequest
  expires: number
}
export class Preparation {
  private plan: Plan | null = null
  private busy = false
  private cancelled = false
  private reviewCache: { epoch: string; review: LibraryReview } | null = null
  private reviewTask: Promise<LibraryReview> | null = null
  constructor(
    private db: LibraryDB,
    private helper: NativeHelper,
    readonly hashes: DuplicateHashes,
    private notify: () => void,
    private classifier?: Pick<Classifier, 'start' | 'wait'>
  ) {
    for (const row of this.db.db.prepare('SELECT id,data FROM playlist_exports').all() as {
      id: string
      data: string
    }[]) {
      const record = JSON.parse(row.data) as ExportRecord
      if (record.status === 'writing') {
        record.status = 'failed'
        record.error =
          'App closed during export. Treat the folder as incomplete; prepare a new export.'
        this.db.db
          .prepare('UPDATE playlist_exports SET data=? WHERE id=?')
          .run(JSON.stringify(record), row.id)
      }
    }
  }
  get running() {
    return this.busy
  }
  cancel() {
    this.cancelled = true
  }
  async close() {
    this.cancel()
    while (this.busy) await new Promise(r => setTimeout(r, 25))
  }
  private guard() {
    if (this.cancelled) throw new Error('Preparation cancelled.')
  }
  private async context(cancellable = true): Promise<Context> {
    const count = (this.db.db.prepare('SELECT COUNT(*) n FROM files').get() as { n: number }).n
    if (count > 100000)
      throw new Error('Preparation supports up to 100,000 catalog files. Reduce the catalog scope.')
    const rows: Row[] = []
    const query = this.db.db.prepare(
      `SELECT f.*, json_object('partialRead',json_extract(f.tags,'$.partialRead')) tags,h.hash, h.error hashError,r.inputHash classificationHash,r.result,r.acknowledgedHash, q.fileId IS NOT NULL queued,a.fingerprint approval,e.year eraYear,e.signature eraSignature,s.enabled sourceEnabled,s.status sourceStatus FROM files f JOIN sources s ON s.id=f.sourceId LEFT JOIN file_hashes h ON h.fileId=f.id AND h.signature=f.signature AND h.physicalKey=f.physicalKey LEFT JOIN classification_results r ON r.fileId=f.id LEFT JOIN classification_queue q ON q.fileId=f.id LEFT JOIN playlist_approvals a ON a.fileId=f.id LEFT JOIN era_years e ON e.fileId=f.id WHERE f.id>? ORDER BY f.id LIMIT 500`
    )
    let cursor = ''
    for (let offset = 0; offset < count; offset += 500) {
      if (cancellable) this.guard()
      const batch = query.all(cursor) as Row[]
      if (!batch.length) break
      cursor = batch.at(-1)!.id
      rows.push(
        ...batch.map(r => ({
          ...r,
          tags: JSON.parse(r.tags as unknown as string),
        }))
      )
      await new Promise<void>(r => setImmediate(r))
    }
    const snapshot = this.db.db
      .prepare('SELECT id,importedAt FROM rb_snapshots WHERE active=1')
      .get() as Context['snapshot'] | undefined
    const refs = new Map<string, Ref[]>()
    if (snapshot)
      for (const ref of this.db.db
        .prepare(
          "SELECT m.fileId,m.trackKey,m.candidates,m.status,m.conflicts,t.attrs,t.tempo,t.cues,t.localPath,(SELECT COUNT(*) FROM rb_memberships p WHERE p.snapshotId=t.snapshotId AND p.trackKey=t.trackKey) playlistReferences FROM rb_matches m JOIN rb_tracks t ON t.snapshotId=m.snapshotId AND t.trackKey=m.trackKey WHERE m.snapshotId=? AND (m.fileId IS NOT NULL OR m.candidates!='[]') ORDER BY m.trackKey"
        )
        .all(snapshot.id) as Ref[]) {
        const targets = new Set<string>([
          ...(ref.fileId ? [ref.fileId] : []),
          ...JSON.parse(ref.candidates),
        ])
        for (const id of targets) {
          const list = refs.get(id) || []
          list.push(ref)
          refs.set(id, list)
        }
      }
    const sources = this.db.sources().filter(s => s.enabled)
    const active = rows.filter(
      r =>
        r.availability === 'available' &&
        r.review !== 'Excluded' &&
        sources.some(s => within(s.path, r.path))
    )
    const unchecked = active.filter(r => !r.hash).length
    const saved = new Map(
      (
        this.db.db.prepare('SELECT * FROM duplicate_decisions').all() as {
          groupKey: string
          fingerprint: string
          keeper: string | null
        }[]
      ).map(r => [r.groupKey, r])
    )
    const groups: DuplicateGroup[] = []
    const decisions = new Map<string, string | null>()
    const blocked = new Map<string, string>()
    const group = (kind: 'exact' | 'candidate', key: string, members: Row[]) => {
      const fingerprint = digest(
        members.map(r => [r.id, r.signature, r.physicalKey, r.path, r.hash, refs.get(r.id) || []])
      )
      const decision = saved.get(key)
      const resolved = decision?.fingerprint === fingerprint
      const keeper = resolved ? decision.keeper : null
      const referenced = members.filter(r =>
        (refs.get(r.id) || []).some(ref => ref.status === 'referenced')
      )
      groups.push({
        key,
        fingerprint,
        kind,
        resolved,
        keeper: keeper || null,
        recommendation: kind === 'exact' && referenced.length === 1 ? referenced[0]!.id : null,
        memberCount: members.length,
        members: members.map(r => ({
          track: {
            id: r.id,
            title: r.title,
            artist: r.artist,
            filename: r.filename,
            path: r.path,
            duration: r.duration,
            format: r.format,
            bitrate: r.bitrate,
            sampleRate: r.sampleRate,
            category: r.category,
            review: r.review,
          },
          references: (refs.get(r.id) || []).filter(ref => ref.status === 'referenced').length,
          playlistReferences: (refs.get(r.id) || [])
            .filter(ref => ref.status === 'referenced')
            .reduce((n, ref) => n + ref.playlistReferences, 0),
          cues: (refs.get(r.id) || []).reduce(
            (sum, ref) => sum + (JSON.parse(ref.cues) as unknown[]).length,
            0
          ),
          grids: (refs.get(r.id) || []).reduce(
            (sum, ref) => sum + (JSON.parse(ref.tempo) as unknown[]).length,
            0
          ),
          hash: r.hash,
        })),
      })
      if (resolved) decisions.set(key, keeper || null)
      for (const member of members) {
        if (!resolved) blocked.set(member.id, 'Duplicate review needed')
        else if (keeper && member.id !== keeper)
          blocked.set(member.id, 'Alternate copy omitted from playlists')
      }
    }
    const exact = new Map<string, Row[]>()
    for (const r of active)
      if (r.hash) {
        const list = exact.get(r.hash) || []
        list.push(r)
        exact.set(r.hash, list)
      }
    for (const [hash, members] of exact)
      if (members.length > 1) group('exact', `exact:${hash}`, members)
    const candidates = new Map<string, Row[]>()
    for (const r of active) {
      if (
        blocked.get(r.id) === 'Alternate copy omitted from playlists' ||
        !r.artist?.trim() ||
        !r.title?.trim()
      )
        continue
      // Keep version words intact. This is intentionally conservative, not acoustic identity.
      const key = normalize(r.artist) + '|' + normalize(r.title)
      const list = candidates.get(key) || []
      list.push(r)
      candidates.set(key, list)
    }
    for (const [key, members] of candidates)
      if (members.length > 1 && !members.every(r => r.hash && r.hash === members[0]!.hash))
        group('candidate', `candidate:${digest(key)}`, members)
    return {
      rows,
      refs,
      groups,
      decisions,
      blocked,
      unchecked,
      snapshot: snapshot || null,
    }
  }
  async duplicates(offset: number): Promise<DuplicatePage> {
    if (this.busy) throw new Error('Playlist preparation is running.')
    this.cancelled = false
    const c = await this.context()
    const groups = c.groups.sort(
      (a, b) => Number(a.resolved) - Number(b.resolved) || a.key.localeCompare(b.key)
    )
    return {
      groups: groups
        .slice(offset, offset + 10)
        .map(group => ({ ...group, members: group.members.slice(0, 50) })),
      total: groups.length,
      unresolved: groups.filter(g => !g.resolved).length,
      unchecked: c.unchecked,
      job: this.hashes.state(),
    }
  }
  async duplicateMembers(key: string, fingerprint: string, offset: number) {
    if (this.busy) throw new Error('Playlist preparation is running.')
    this.cancelled = false
    const group = (await this.context()).groups.find(g => g.key === key)
    if (!group || group.fingerprint !== fingerprint)
      throw new Error('Duplicate group changed. Refresh the workflow.')
    return group.members.slice(offset, offset + 50)
  }
  async resolve(key: string, fingerprint: string, keeper: string | null) {
    if (this.busy || this.hashes.running)
      throw new Error('Finish preparation or pause the duplicate check first.')
    this.cancelled = false
    const c = await this.context()
    const group = c.groups.find(g => g.key === key)
    if (!group || group.fingerprint !== fingerprint)
      throw new Error('This duplicate group changed. Refresh it before deciding.')
    if (keeper && !group.members.some(m => m.track.id === keeper))
      throw new Error('Keeper is outside this group.')
    this.db.db
      .prepare(
        'INSERT INTO duplicate_decisions VALUES(?,?,?,?) ON CONFLICT(groupKey) DO UPDATE SET fingerprint=excluded.fingerprint,keeper=excluded.keeper,decidedAt=excluded.decidedAt'
      )
      .run(key, fingerprint, keeper, new Date().toISOString())
    this.plan = null
    this.notify()
  }
  async autoChoose(replaceExisting = false) {
    if (this.busy || this.hashes.running)
      throw new Error('Finish the current preparation or duplicate check first.')
    this.busy = true
    this.cancelled = false
    try {
      let c = await this.context()
      if (c.unchecked)
        throw new Error('Finish Check duplicates before choosing copies automatically.')
      const result = {
        exactGroups: 0,
        candidateGroups: 0,
        versionsKept: 0,
        preservedChoices: replaceExisting ? 0 : c.groups.filter(g => g.resolved).length,
      }
      const existingCandidates = new Map(
        c.groups
          .filter(g => !replaceExisting && g.kind === 'candidate' && g.resolved)
          .map(g => [g.key, g])
      )
      const explicitKeepers = new Set(
        c.groups.filter(g => !replaceExisting && g.resolved && g.keeper).map(g => g.keeper!)
      )
      const keepAllIds = new Set(
        c.groups
          .filter(g => !replaceExisting && g.resolved && !g.keeper)
          .flatMap(g => g.members.map(m => m.track.id))
      )
      const save = this.db.db.prepare(
        'INSERT INTO duplicate_decisions VALUES(?,?,?,?) ON CONFLICT(groupKey) DO UPDATE SET fingerprint=excluded.fingerprint,keeper=excluded.keeper,decidedAt=excluded.decidedAt'
      )
      const apply = (groups: DuplicateGroup[]) =>
        this.db.db.transaction(() => {
          for (const g of groups) {
            if (g.resolved && !replaceExisting) continue
            const protectedMembers = g.members.filter(m => explicitKeepers.has(m.track.id))
            const prior = existingCandidates.get(g.key)
            let keep: string | null
            if (prior && (!prior.keeper || g.members.some(m => m.track.id === prior.keeper)))
              keep = prior.keeper
            else if (
              g.kind === 'exact' &&
              (g.members.some(m => keepAllIds.has(m.track.id)) || protectedMembers.length > 1)
            )
              keep = null
            else if (g.kind === 'exact' && protectedMembers.length === 1)
              keep = protectedMembers[0]!.track.id
            else
              keep =
                g.kind === 'exact' || comparableVersions(g.members)
                  ? bestCopy(g.members).track.id
                  : null
            save.run(g.key, g.fingerprint, keep, new Date().toISOString())
            if (g.kind === 'exact') result.exactGroups++
            else if (keep) result.candidateGroups++
            else result.versionsKept++
          }
        })()
      apply(c.groups.filter(g => g.kind === 'exact'))
      c = await this.context() // Exact decisions change candidate membership.
      apply(c.groups.filter(g => g.kind === 'candidate'))
      this.plan = null
      this.notify()
      return result
    } finally {
      this.busy = false
    }
  }
  async cleanupCandidates(includeReferenced = false) {
    this.cancelled = false
    const c = await this.context()
    const protectedCounts: Record<string, number> = {}
    const held = (reason: string) => {
      protectedCounts[reason] = (protectedCounts[reason] || 0) + 1
    }
    const referenced = new Set<string>()
    for (const ref of this.db.db.prepare('SELECT fileId,candidates FROM rb_matches').all() as {
      fileId: string | null
      candidates: string
    }[]) {
      if (ref.fileId) referenced.add(ref.fileId)
      for (const id of JSON.parse(ref.candidates)) referenced.add(id)
    }
    const paths = new Set(
      (
        this.db.db.prepare('SELECT localPath FROM rb_tracks WHERE localPath IS NOT NULL').all() as {
          localPath: string
        }[]
      ).map(r => r.localPath)
    )
    for (const row of this.db.db.prepare('SELECT manifest FROM playlist_exports').all() as {
      manifest: string
    }[]) {
      for (const t of JSON.parse(row.manifest).tracks || []) {
        if (t.id) referenced.add(t.id)
        if (t.path) paths.add(t.path)
      }
    }
    let referencedExtras = 0
    const rows = new Map(c.rows.map(r => [r.id, r]))
    const items: { file: CatalogFile; keeper: CatalogFile; hash: string }[] = []
    const active = this.db.sources().filter(s => s.enabled && s.status === 'ready' && !s.demo)
    for (const g of c.groups) {
      if (g.kind !== 'exact') continue
      if (!g.resolved || !g.keeper) {
        held(g.resolved ? 'Keep-all choice preserved' : 'Choose best copies first')
        continue
      }
      const keeper = rows.get(g.keeper)!
      for (const m of g.members) {
        if (m.track.id === g.keeper) continue
        const file = rows.get(m.track.id)!
        const hasReferences = referenced.has(file.id) || paths.has(file.path)
        if (hasReferences && !includeReferenced) {
          held('Referenced by a Rekordbox snapshot or saved export')
          continue
        }
        if (
          !active.some(s => within(s.path, file.path)) ||
          !active.some(s => within(s.path, keeper.path))
        ) {
          held('Source paused or scan incomplete')
          continue
        }
        const locations = this.db.db
          .prepare('SELECT COUNT(DISTINCT path) n FROM locations WHERE fileId=? AND available=1')
          .get(file.id) as { n: number }
        if (locations.n !== 1) {
          held('Multiple catalog locations')
          continue
        }
        if (
          file.metadataError ||
          file.tags.partialRead ||
          keeper.metadataError ||
          keeper.tags.partialRead
        ) {
          held('Incomplete file metadata')
          continue
        }
        if (hasReferences) referencedExtras++
        items.push({ file, keeper, hash: file.hash! })
      }
    }
    return {
      items,
      includeReferenced,
      referencedExtras,
      protected: protectedCounts,
      decisions: c.groups
        .filter(g => g.resolved)
        .map(g => ({
          key: g.key,
          keeper: g.keeper,
          members: g.members.map(m => m.track.id),
        })),
    }
  }
  async reconcileCleanupChoices(
    choices: { key: string; keeper: string | null; members: string[] }[]
  ) {
    const prior = new Map(choices.map(c => [c.key, c]))
    for (const kind of ['exact', 'candidate']) {
      const c = await this.context()
      this.db.db.transaction(() => {
        for (const group of c.groups.filter(g => g.kind === kind)) {
          const old = prior.get(group.key)
          if (!old) continue
          const current = this.db.db
            .prepare('SELECT keeper FROM duplicate_decisions WHERE groupKey=?')
            .get(group.key) as { keeper: string | null } | undefined
          const ids = new Set(old.members)
          if (
            current?.keeper !== old.keeper ||
            !group.members.every(m => ids.has(m.track.id)) ||
            (old.keeper && !group.members.some(m => m.track.id === old.keeper))
          )
            continue
          this.db.db
            .prepare('UPDATE duplicate_decisions SET fingerprint=? WHERE groupKey=?')
            .run(group.fingerprint, group.key)
        }
      })()
    }
    this.plan = null
    this.notify()
  }
  private prepare(c: Context, request: PreparationRequest): Prepared[] {
    const ids = new Set(request.ids)
    const relatedById = new Map<string, unknown[]>()
    for (const g of c.groups)
      for (const member of g.members) {
        const related = relatedById.get(member.track.id) || []
        related.push([g.key, g.fingerprint, c.decisions.has(g.key), c.decisions.get(g.key)])
        relatedById.set(member.track.id, related)
      }
    return c.rows
      .filter(
        r =>
          !['trashed', 'removed'].includes(r.availability) &&
          (request.scope === 'all' || ids.has(r.id))
      )
      .map(row => {
        const references = c.refs.get(row.id) || []
        const result = row.result ? JSON.parse(row.result) : null
        const isReggaeton = row.category?.startsWith('Reggaeton') === true
        const confirmedEra = row.eraSignature === row.signature && row.eraYear !== null
        const outputCategory = isReggaeton && !confirmedEra ? 'Reggaeton' : row.category
        const yearOnlyReview =
          isReggaeton &&
          !confirmedEra &&
          ['Verify Release Year', 'Missing Year'].includes(row.review)
        const notes: string[] = []
        if (isReggaeton && !confirmedEra)
          notes.push(
            'Playlist category is general Reggaeton until its year is confirmed. Confirm a recording/version year in Track Details only if you want Old/New playlists; your saved category and tags stay unchanged.'
          )
        const metadataDifferences =
          references.length === 1 &&
          references[0]!.status === 'referenced' &&
          references[0]!.localPath === row.path
            ? (JSON.parse(references[0]!.conflicts) as string[])
            : []
        const ordinaryDifferences = metadataDifferences.every(difference =>
          /^(Artist|Genre|Tonality|AverageBpm|Year):/.test(difference)
        )
        if (metadataDifferences.length && ordinaryDifferences)
          notes.push(
            'Rekordbox metadata differs from embedded tags. Export keeps the exact-path snapshot metadata, cues and grids: ' +
              metadataDifferences.join('; ')
          )
        let reason: string | null = null
        if (row.review === 'Excluded') reason = 'Excluded by you'
        else if (row.availability !== 'available') reason = 'File unavailable'
        else if (!row.sourceEnabled || row.sourceStatus !== 'ready')
          reason = 'Source disabled or scan incomplete'
        else if (row.queued || !row.classificationHash) reason = 'Classification pending'
        else if (row.metadataError || row.tags.partialRead) reason = 'Partial metadata needs review'
        else if (!row.category || !MUSIC_CATEGORIES.includes(row.category as any))
          reason = 'No performance category'
        else if (row.review !== 'Ready for Approval' && !yearOnlyReview) reason = row.review
        else if (result?.manualConflict && row.acknowledgedHash !== row.classificationHash)
          reason = 'Classification conflict'
        else if (
          isReggaeton &&
          confirmedEra &&
          row.category !== 'Reggaeton' &&
          row.eraYear! <= 2007 !== (row.category === 'Reggaeton Old')
        )
          reason = 'Confirm recording/version year'
        else if (
          references.length > 1 ||
          references.some(
            r => r.status !== 'referenced' || r.localPath !== row.path || !ordinaryDifferences
          )
        )
          reason = 'Rekordbox reference conflict'
        else if (c.blocked.has(row.id)) reason = c.blocked.get(row.id)!
        else if (!row.hash)
          reason = row.hashError ? 'File check failed; rescan or exclude' : 'Duplicate check needed'
        else if (c.unchecked) reason = 'Finish duplicate check for enabled sources'
        else if (/[\r\n\0]/.test(row.path)) reason = 'Filename contains a line break'
        const related = relatedById.get(row.id) || []
        const fingerprint = digest([
          row.id,
          row.signature,
          row.physicalKey,
          row.path,
          row.revision,
          row.category,
          row.review,
          row.classificationHash,
          row.eraYear,
          row.eraSignature,
          row.hash,
          related,
          references,
          ...(outputCategory !== row.category ? [outputCategory] : []),
        ])
        return {
          row,
          reference: references[0] || null,
          fingerprint,
          item: {
            id: row.id,
            title: row.title || row.filename,
            artist: row.artist || '',
            path: row.path,
            category: outputCategory,
            catalogCategory: row.category,
            notes,
            reason,
            approved: !reason && row.approval === fingerprint,
            known: references.some(r => r.status === 'referenced'),
          },
        }
      })
  }
  private reviewEpoch() {
    return JSON.stringify([
      this.db.db.prepare('SELECT total_changes() n').get(),
      this.db.db.pragma('data_version', { simple: true }),
    ])
  }
  private async libraryReview(): Promise<LibraryReview> {
    const epoch = this.reviewEpoch()
    if (this.reviewCache?.epoch === epoch) return this.reviewCache.review
    if (this.reviewTask) return this.reviewTask
    this.reviewTask = (async () => {
      // Context reads yield between bounded catalog batches. Rebuild if a scan,
      // classification or another connection changes evidence during a read.
      for (let attempt = 0; attempt < 3; attempt++) {
        const start = this.reviewEpoch()
        const items = this.prepare(await this.context(false), {
          scope: 'all',
          ids: [],
        }).map(({ item }) => item)
        if (start !== this.reviewEpoch()) continue
        const review = new LibraryReview(this.db, items)
        this.reviewCache = { epoch: start, review }
        return review
      }
      throw new Error('Library is updating. Refresh Review in a moment.')
    })()
    try {
      return await this.reviewTask
    } finally {
      this.reviewTask = null
    }
  }
  async reviewOverview(): Promise<LibraryReviewOverview> {
    return (await this.libraryReview()).overview()
  }
  async reviewList(query: LibraryQuery): Promise<LibraryPage> {
    return (await this.libraryReview()).list(query)
  }
  async preview(request: PreparationRequest): Promise<PreparationPreview> {
    if (this.busy || this.hashes.running)
      throw new Error('Finish or pause the duplicate check before preparing playlists.')
    this.busy = true
    this.cancelled = false
    this.plan = null
    try {
      const c = await this.context()
      const items = this.prepare(c, request)
      const eligible = items.filter(i => !i.item.reason)
      const reasons: Record<string, number> = {}
      const categories: Record<string, number> = {}
      for (const { item } of items) {
        if (item.reason) reasons[item.reason] = (reasons[item.reason] || 0) + 1
        else categories[item.category!] = (categories[item.category!] || 0) + 1
      }
      const approved = eligible.filter(i => i.item.approved).length
      const known = eligible.filter(i => i.item.known).length
      const preview: PreparationPreview = {
        token: randomUUID(),
        total: items.length,
        eligible: eligible.length,
        approved,
        needsApproval: eligible.length - approved,
        blocked: items.length - eligible.length,
        reasons,
        categories,
        known,
        newToSnapshot: eligible.length - known,
        snapshotAt: c.snapshot?.importedAt || null,
      }
      this.plan = {
        preview,
        items,
        request,
        expires: Date.now() + 15 * 60 * 1000,
      }
      return preview
    } finally {
      this.busy = false
    }
  }
  private getPlan(token: string) {
    if (!this.plan || this.plan.preview.token !== token || this.plan.expires < Date.now())
      throw new Error('Preview expired or changed. Prepare a fresh preview.')
    return this.plan
  }
  page(token: string, offset: number, filter: 'all' | 'eligible' | 'blocked', reason?: string) {
    const items = this.getPlan(token)
      .items.map(i => i.item)
      .filter(
        i =>
          (filter === 'all' || (filter === 'eligible' ? !i.reason : !!i.reason)) &&
          (!reason || i.reason === reason)
      )
    return { items: items.slice(offset, offset + 50), total: items.length }
  }
  private async current(plan: Plan) {
    const items = this.prepare(await this.context(), plan.request)
    if (
      digest(items.map(i => [i.item.id, i.fingerprint, i.item.reason, i.item.approved])) !==
      digest(plan.items.map(i => [i.item.id, i.fingerprint, i.item.reason, i.item.approved]))
    )
      throw new Error('Library, approvals or duplicate evidence changed. Prepare a fresh preview.')
    return items
  }
  async classify(
    token: string,
    ids: string[],
    category: (typeof MUSIC_CATEGORIES)[number] | null
  ): Promise<PreparationPreview> {
    if (this.busy || this.hashes.running)
      throw new Error('Finish the current preparation or duplicate check first.')
    if (!this.classifier) throw new Error('Category review is unavailable in this session.')
    this.busy = true
    this.cancelled = false
    let request: PreparationRequest
    try {
      const plan = this.getPlan(token)
      const items = await this.current(plan)
      const selected = new Set(ids)
      if (!ids.length || ids.length > 1000 || selected.size !== ids.length)
        throw new Error('Select between 1 and 1,000 distinct tracks.')
      const chosen = items.filter(item => selected.has(item.item.id))
      if (chosen.length !== ids.length)
        throw new Error('Selection is outside this preview. No changes were saved.')
      const changes = chosen.map(item => ({
        item,
        category: category ?? item.row.category,
      }))
      if (changes.some(change => !MUSIC_CATEGORIES.includes(change.category as any)))
        throw new Error(
          'Choose a performance category for unclassified or workflow tracks. No changes were saved.'
        )
      this.guard()
      this.db.db.transaction(() => {
        for (const change of changes)
          this.db.updateDecision(
            [{ id: change.item.row.id, revision: change.item.row.revision }],
            'category',
            change.category
          )
      })()
      request = plan.request
      this.plan = null
      // Category decisions enqueue evidence refresh via the existing SQLite trigger.
      // Run pending local work even when automatic classification is paused.
      this.classifier.start()
      await this.classifier.wait()
      this.notify()
      if (this.cancelled)
        throw new Error('Categories saved. Preview cancelled; preview all tracks again.')
    } finally {
      this.busy = false
    }
    return this.preview(request)
  }
  async approve(token: string) {
    if (this.busy || this.hashes.running)
      throw new Error('Another preparation operation is running.')
    this.busy = true
    this.cancelled = false
    try {
      const plan = this.getPlan(token)
      const items = await this.current(plan)
      this.guard()
      const insert = this.db.db.prepare(
        'INSERT INTO playlist_approvals VALUES(?,?,?) ON CONFLICT(fileId) DO UPDATE SET fingerprint=excluded.fingerprint,approvedAt=excluded.approvedAt'
      )
      this.db.db.transaction(() => {
        for (const i of items)
          if (!i.item.reason) insert.run(i.item.id, i.fingerprint, new Date().toISOString())
      })()
      this.plan = null
      this.notify()
    } finally {
      this.busy = false
    }
  }
  history(): ExportRecord[] {
    const active = this.db.db.prepare('SELECT id,hash FROM rb_snapshots WHERE active=1').get() as
      { id: string; hash: string } | undefined
    return (
      this.db.db
        .prepare('SELECT data FROM playlist_exports ORDER BY rowid DESC LIMIT 20')
        .all() as { data: string }[]
    ).map(row => {
      const record = JSON.parse(row.data) as ExportRecord
      if (record.verification)
        record.verification.current = record.verification.snapshot
          ? record.verification.snapshot.id === active?.id &&
            record.verification.snapshot.hash === active?.hash
          : !active
      return record
    })
  }
  async verify(id: string): Promise<ExportRecord> {
    if (this.busy || this.hashes.running)
      throw new Error('Finish the current preparation operation first.')
    this.busy = true
    this.cancelled = false
    try {
      const row = this.db.db
        .prepare('SELECT data,manifest FROM playlist_exports WHERE id=?')
        .get(id) as { data: string; manifest: string } | undefined
      const record = row ? (JSON.parse(row.data) as ExportRecord) : null
      if (!row || record?.status !== 'exported') throw new Error('Completed export not found.')
      const verification = await verifyExport(this.db, record, row.manifest, () => this.guard())
      this.guard()
      // Retain a user-reported import recorded while the comparison yielded.
      const latest = JSON.parse(
        (
          this.db.db.prepare('SELECT data FROM playlist_exports WHERE id=?').get(id) as {
            data: string
          }
        ).data
      ) as ExportRecord
      latest.verification = verification
      this.db.db
        .prepare('UPDATE playlist_exports SET data=? WHERE id=?')
        .run(JSON.stringify(latest), id)
      this.notify()
      return latest
    } finally {
      this.busy = false
    }
  }
  reportImported(id: string) {
    const record = this.history().find(r => r.id === id)
    if (!record || record.status !== 'exported') throw new Error('Export not found.')
    record.reportedImportedAt = new Date().toISOString()
    this.db.db
      .prepare('UPDATE playlist_exports SET data=? WHERE id=?')
      .run(JSON.stringify(record), id)
    this.notify()
  }
  async sync(
    autoApprove: boolean,
    version: string,
    publish: (xml: string, guard: () => void) => Promise<void>,
    blockedPreparation: string | null = null
  ) {
    if (this.busy || this.hashes.running)
      throw new Error('Another preparation operation is running.')
    this.busy = true
    this.cancelled = false
    try {
      const request = { scope: 'all' as const, ids: [] }
      const items = this.prepare(await this.context(), request)
      const eligible = items.filter(i => !i.item.reason)
      let preparedIssue = blockedPreparation
      let selected = preparedIssue ? [] : eligible.filter(i => autoApprove || i.item.approved)
      const organization = managedOrganization(this.db)
      const evidence = digest([
        items.map(i => [i.fingerprint, i.item.reason, i.item.approved]),
        organization,
      ])
      const candidates = new Map<string, Row[]>()
      for (const item of items) {
        if (item.row.availability !== 'available') continue
        const key = managedPath(item.row.path)
        const group = candidates.get(key) || []
        group.push(item.row)
        candidates.set(key, group)
      }
      const practice: ManagedPracticeTrack[] = []
      let practiceOmitted = 0
      for (const [key, rows] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
        this.guard()
        const current: Row[] = []
        if (!/[\r\n\0]/.test(key)) {
          for (const row of rows.sort((a, b) => a.id.localeCompare(b.id))) {
            this.guard()
            try {
              await validateAudio(this.db, this.helper, row)
              current.push(row)
            } catch {
              // A stale/missing file is omitted from practice without granting it approval.
              this.guard()
            }
          }
        }
        const identities = new Set(current.map(row => `${row.physicalKey}|${row.signature}`))
        if (!current.length || identities.size !== 1) {
          practiceOmitted++
          continue
        }
        practice.push({
          track: current[0]!,
          ids: current.map(row => row.id),
        })
      }
      const freshPaths = new Map(practice.map(entry => [managedPath(entry.track.path), entry]))
      if (
        selected.some(
          item => !freshPaths.get(managedPath(item.row.path))?.ids.includes(item.row.id)
        )
      ) {
        preparedIssue ||=
          'A prepared file changed or is unavailable. Run Smart Scan before exporting prepared playlists.'
        selected = []
      }
      if (new Set(selected.map(item => managedPath(item.row.path))).size !== selected.length) {
        preparedIssue ||= 'Repeated catalogue paths need Smart Scan before preparing playlists.'
        selected = []
      }
      const validate = async () => {
        this.guard()
        for (const entry of practice) {
          this.guard()
          await validateAudio(this.db, this.helper, entry.track)
        }
        const current = this.prepare(await this.context(), request)
        if (
          evidence !==
          digest([
            current.map(i => [i.fingerprint, i.item.reason, i.item.approved]),
            managedOrganization(this.db),
          ])
        )
          throw new Error('Library evidence changed while preparing sync. Check again.')
        this.guard()
      }
      await validate()
      const ids = await managedTrackIDs(
        this.db.directory,
        practice.map(entry => entry.track.path),
        () => this.guard()
      )
      const built = managedLibraryXML(
        practice,
        selected.map(i => ({
          track: { ...i.row, category: i.item.category },
          reference: i.reference,
        })),
        organization,
        SYNC_NAMESPACE,
        version,
        ids
      )
      const xml = built.xml
      await validateExportXML(xml, this.db.directory, this.helper, () => this.cancelled)
      await validate()
      await publish(xml, () => this.guard())
      // Standing consent applies only to currently eligible evidence; unconfirmed eras use the general playlist.
      if (autoApprove) {
        const insert = this.db.db.prepare(
          'INSERT INTO playlist_approvals VALUES(?,?,?) ON CONFLICT(fileId) DO UPDATE SET fingerprint=excluded.fingerprint,approvedAt=excluded.approvedAt'
        )
        this.db.db.transaction(() => {
          for (const i of selected) insert.run(i.item.id, i.fingerprint, new Date().toISOString())
        })()
      }
      this.plan = null
      this.notify()
      return {
        tracks: selected.length,
        held: items.length - eligible.length,
        awaitingApproval: eligible.filter(item => !item.item.approved && !selected.includes(item))
          .length,
        practiceTracks: built.practiceTracks,
        practicePlaylists: built.practicePlaylists,
        practiceOmitted,
        preparedIssue,
      }
    } finally {
      this.busy = false
    }
  }
  async export(token: string, parent: string, version: string): Promise<ExportRecord> {
    if (this.busy || this.hashes.running)
      throw new Error('Another preparation operation is running.')
    this.busy = true
    this.cancelled = false
    let record: ExportRecord | null = null
    try {
      const plan = this.getPlan(token)
      const current = await this.current(plan)
      const items = current.filter(i => !i.item.reason && i.item.approved)
      if (!items.length || current.some(i => !i.item.reason && !i.item.approved))
        throw new Error('Approve the eligible classifications before exporting.')
      for (const i of items) {
        this.guard()
        await validateAudio(this.db, this.helper, i.row)
      }
      await this.current(plan)
      this.guard()
      const id = randomUUID()
      const createdAt = new Date().toISOString()
      const namespace = `DJ Library Organizer ${createdAt.slice(0, 16).replace('T', ' ')} ${id.slice(0, 8)}`
      const directory = path.join(await realpath(parent), namespace.replaceAll(':', '-'))
      const files = playlistFiles(
        items.map(i => ({
          track: { ...i.row, category: i.item.category },
          reference: i.reference,
        })),
        namespace,
        version
      )
      await validateExportXML(
        files['rekordbox.xml']!,
        this.db.directory,
        this.helper,
        () => this.cancelled
      )
      await this.current(plan)
      this.guard()
      const manifest = {
        version: 1,
        id,
        createdAt,
        namespace,
        tracks: items.map(i => ({
          id: i.row.id,
          path: i.row.path,
          category: i.item.category,
          sha256: i.row.hash,
          approval: i.fingerprint,
          knownInSnapshot: i.item.known,
        })),
        files: Object.entries(files).map(([name, value]) => ({
          name,
          sha256: createHash('sha256').update(value).digest('hex'),
        })),
        importStatus: 'Not verified in rekordbox',
      }
      files['manifest.json'] = JSON.stringify(manifest, null, 2) + '\n'
      files['READ ME.txt'] = IMPORT_GUIDE
      record = {
        id,
        createdAt,
        directory,
        namespace,
        tracks: items.length,
        status: 'writing',
        error: null,
        reportedImportedAt: null,
      }
      this.db.db
        .prepare('INSERT INTO playlist_exports VALUES(?,?,?)')
        .run(id, JSON.stringify(record), JSON.stringify(manifest))
      await mkdir(directory, { mode: 0o700 })
      for (const [name, value] of Object.entries(files)) {
        this.guard()
        const file = await open(path.join(directory, name), 'wx', 0o600)
        try {
          await file.writeFile(value, 'utf8')
          await file.sync()
        } finally {
          await file.close()
        }
      }
      for (const i of items) {
        this.guard()
        await validateAudio(this.db, this.helper, i.row)
      }
      await this.current(plan)
      this.guard()
      const complete = await open(path.join(directory, 'COMPLETE.txt'), 'wx', 0o600)
      try {
        await complete.writeFile(
          'All playlist artifacts and source paths were validated at export time. Import in rekordbox is not yet verified.\n'
        )
        await complete.sync()
      } finally {
        await complete.close()
      }
      record.completedAt = new Date().toISOString()
      record.status = 'exported'
      this.db.db
        .prepare('UPDATE playlist_exports SET data=? WHERE id=?')
        .run(JSON.stringify(record), id)
      this.plan = null
      this.notify()
      return record
    } catch (error) {
      if (record) {
        record.status = 'failed'
        record.error = error instanceof Error ? error.message : 'Export failed.'
        this.db.db
          .prepare('UPDATE playlist_exports SET data=? WHERE id=?')
          .run(JSON.stringify(record), record.id)
        this.notify()
      }
      throw error
    } finally {
      this.busy = false
    }
  }
}

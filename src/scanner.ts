import path from 'node:path'
import { homedir } from 'node:os'
import { PARSER_REVISION } from './metadata'
import { readdir, realpath, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import type { Inspection, NativeHelper } from './native'
import { LibraryDB } from './db'
export { stablePhysicalKey } from './file-identity'
import type { ScanProgress, Source, Track } from './shared'

export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.m4a',
  '.aac',
  '.mp4',
  '.flac',
  '.fla',
  '.wav',
  '.wave',
  '.aif',
  '.aiff',
  '.aifc',
  '.alac',
  '.ogg',
  '.opus',
  '.ape',
  '.wma',
  '.wv',
  '.dsf',
])
export const EXCLUDED = new Set([
  'node_modules',
  '.git',
  '.trash',
  '.trashes',
  '.cache',
  '.npm',
  '.local',
  'caches',
  'cache',
  'backups',
  'backup',
  'temporary items',
])
export const SYSTEM_DIRECTORIES = new Set(
  [
    '/System',
    '/Library',
    '/Applications',
    '/private',
    '/usr',
    '/bin',
    '/sbin',
    '/dev',
    '/cores',
    '/opt',
    path.join(homedir(), 'Library'),
  ].map(p => p.toLowerCase())
)
export const TEMP = /\.(part|partial|crdownload|download|tmp|temp)$/i
export const PACKAGE =
  /\.(app|bundle|framework|photoslibrary|musiclibrary|band|pkg|sparsebundle|backupdb)$/i
export function within(root: string, file: string) {
  const relative = path.relative(root, file)
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  )
}
export function signature(i: Inspection) {
  return `${i.size}|${i.mtime}|${i.ctime}`
}
export function physicalKey(i: Inspection) {
  return `${i.volume || i.device}|${i.device}|${i.inode}|${i.birth}`
}

class MetadataReader {
  constructor(private executable: string) {}
  read(filePath: string, signal: AbortSignal, expected: Inspection): Promise<any> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Cancelled'))
        return
      }
      const worker = new Worker(this.executable, {
        resourceLimits: {
          maxOldGenerationSizeMb: 96,
          maxYoungGenerationSizeMb: 16,
        },
      })
      let done = false
      const finish = (error: Error | null, value?: unknown) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        void worker.terminate()
        error ? reject(error) : resolve(value)
      }
      const abort = () => finish(new Error('Cancelled'))
      const timer = setTimeout(
        () => finish(new Error('Metadata read exceeded its 15-second limit. File left unchanged.')),
        15000
      )
      signal.addEventListener('abort', abort, { once: true })
      worker.on('error', e => finish(e instanceof Error ? e : new Error(String(e))))
      worker.on('exit', code => {
        if (!done) finish(new Error(`Metadata worker stopped (${code})`))
      })
      worker.on('message', m =>
        m.ok
          ? finish(null, m.value)
          : finish(Object.assign(new Error(m.error), { partial: m.partial }))
      )
      worker.postMessage({
        path: filePath,
        expected: {
          device: expected.device,
          inode: expected.inode,
          size: expected.size,
        },
      })
    })
  }
}
export class Scanner {
  private abort: AbortController | null = null
  private task: Promise<void> | null = null
  progress: ScanProgress | null = null
  private metadata: MetadataReader
  constructor(
    private db: LibraryDB,
    private native: NativeHelper,
    metadataWorker: string,
    private notify: (p: ScanProgress) => void,
    private excludedRoots: string[] = []
  ) {
    this.metadata = new MetadataReader(metadataWorker)
  }
  get running() {
    return this.abort !== null
  }
  cancel() {
    this.abort?.abort()
  }
  async wait() {
    await this.task
  }
  start(kind: 'smart' | 'discovery', selectedSources?: Source[]): boolean {
    if (this.running)
      throw new Error('A scan is already running. Cancel it or wait for it to finish.')
    let sources = (selectedSources || this.db.sources()).filter(s => s.enabled)
    if (!sources.length) throw new Error('Choose a source folder first.')
    const last = this.db.summary().lastScan
    const resumable =
      !selectedSources &&
      last &&
      ['interrupted', 'cancelled'].includes(last.status) &&
      last.kind === kind &&
      (!last.sourceIds || last.sourceIds.every(id => sources.some(s => s.id === id)))
    if (resumable && last.sourceIds)
      sources = sources.filter(source => last.sourceIds!.includes(source.id))
    this.progress = resumable
      ? {
          ...last,
          status: 'running',
          finishedAt: null,
          coverage: 'in-progress',
        }
      : {
          id: randomUUID(),
          kind,
          status: 'running',
          visited: 0,
          audio: 0,
          newFiles: 0,
          changed: 0,
          unchanged: 0,
          skipped: 0,
          bytes: 0,
          currentPath: '',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          issues: [],
          coverage: 'in-progress',
          sourceIds: sources.map(source => source.id),
          incompleteSourceIds: [],
        }
    this.abort = new AbortController()
    this.db.saveScan(this.progress)
    this.task = this.run(sources, this.abort.signal, Boolean(resumable))
    return true
  }
  // Incremental arrivals never claim full coverage or mark unvisited files missing.
  startArrivals(entries: { source: Source; path: string; stamp: string }[]) {
    if (this.running) throw new Error('A scan is already running.')
    if (!entries.length || entries.length > 50) throw new Error('Choose 1–50 settled arrivals.')
    this.progress = {
      id: randomUUID(),
      kind: 'smart',
      incremental: true,
      status: 'running',
      visited: 0,
      audio: 0,
      newFiles: 0,
      changed: 0,
      unchanged: 0,
      skipped: 0,
      bytes: 0,
      currentPath: '',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      issues: [],
      coverage: 'partial',
      sourceIds: [...new Set(entries.map(e => e.source.id))],
      incompleteSourceIds: [],
    }
    this.abort = new AbortController()
    const signal = this.abort.signal
    this.task = (async () => {
      const p = this.progress!
      try {
        for (const entry of entries) {
          if (signal.aborted) break
          if (!this.db.sources().some(s => s.id === entry.source.id && s.enabled)) continue
          p.currentPath = entry.path
          const info = await this.native.inspect(entry.path).catch(() => null)
          if (!info || `${physicalKey(info)}|${signature(info)}` !== entry.stamp) continue
          p.visited++
          await this.file(entry.source, entry.path, signal)
          p.audio++
          this.emit()
        }
        p.status = signal.aborted ? 'cancelled' : 'completed'
      } catch (e) {
        p.status = 'failed'
        this.issue(p.currentPath, e instanceof Error ? e.message : String(e))
      } finally {
        p.finishedAt = new Date().toISOString()
        this.abort = null
        this.emit()
      }
    })()
  }
  private emit() {
    if (this.progress) {
      this.db.saveScan(this.progress)
      this.notify({ ...this.progress, issues: [...this.progress.issues] })
    }
  }
  private issue(filePath: string, reason: string) {
    if (this.progress && this.progress.issues.length < 200)
      this.progress.issues.push({
        path: filePath,
        reason: reason.slice(0, 1000),
      })
  }
  private async run(sources: Source[], signal: AbortSignal, resume: boolean) {
    const p = this.progress!
    p.incompleteSourceIds ??= []
    let partial = p.incompleteSourceIds.length > 0
    let lastEmit = 0
    try {
      const visitedDirs = new Set<string>()
      for (const source of sources) {
        if (signal.aborted) break
        let complete = !p.incompleteSourceIds.includes(source.id)
        this.db.db.prepare("UPDATE sources SET status='scanning' WHERE id=?").run(source.id)
        try {
          await access(source.path, constants.R_OK)
          const i = await this.native.inspect(source.path)
          if (!i.directory || i.alias || i.package || i.cloudOnly || i.availabilityUnknown)
            throw new Error('Source is not a locally available ordinary folder.')
        } catch (e) {
          partial = true
          if (!p.incompleteSourceIds.includes(source.id)) p.incompleteSourceIds.push(source.id)
          this.issue(
            source.path,
            'Source unavailable: ' + (e instanceof Error ? e.message : String(e))
          )
          this.db.db.prepare("UPDATE sources SET status='unavailable' WHERE id=?").run(source.id)
          this.db.db
            .prepare(
              "UPDATE files SET availability='unavailable' WHERE availability NOT IN ('trashed','removed') AND NOT EXISTS(SELECT 1 FROM locations l JOIN sources s ON s.id=l.sourceId WHERE l.fileId=files.id AND s.status!='unavailable')"
            )
            .run()
          continue
        }
        const checkpointCount = (
          this.db.db
            .prepare('SELECT COUNT(*) n FROM scan_queue WHERE scanId=? AND sourceId=?')
            .get(p.id, source.id) as { n: number }
        ).n
        if (!resume || checkpointCount === 0) {
          if (p.kind === 'smart' && source.broad) {
            const known = this.db.db
              .prepare('SELECT DISTINCT path FROM locations WHERE sourceId=?')
              .all(source.id) as { path: string }[]
            for (const location of known)
              this.db.enqueue(p.id, source.id, path.dirname(location.path))
            this.db.enqueue(p.id, source.id, path.join(source.path, 'Downloads'))
          } else this.db.enqueue(p.id, source.id, source.path)
        }
        let next
        while (!signal.aborted && (next = this.db.nextDirectory(p.id, source.id))) {
          const dir = next.path
          p.currentPath = dir
          try {
            const actual = await realpath(dir)
            if (
              !within(source.path, actual) ||
              this.excludedRoots.some(root => within(root, actual))
            ) {
              p.skipped++
              this.issue(dir, 'Excluded from discovery scope.')
              this.db.directoryDone(p.id, source.id, dir)
              continue
            }
            const inspected = await this.native.inspect(dir)
            if (
              !inspected.directory ||
              inspected.alias ||
              inspected.package ||
              inspected.cloudOnly ||
              inspected.availabilityUnknown
            ) {
              p.skipped++
              complete = false
              this.issue(dir, 'Skipped bundle, alias, or unavailable folder.')
              this.db.directoryDone(p.id, source.id, dir)
              continue
            }
            const identity = `${source.id}:${physicalKey(inspected)}`
            if (visitedDirs.has(identity)) {
              this.db.directoryDone(p.id, source.id, dir)
              continue
            }
            visitedDirs.add(identity)
            const entries = await readdir(dir, { withFileTypes: true })
            entries.sort(
              (a, b) =>
                Number(!['Downloads', 'Music', 'Desktop', 'Documents'].includes(a.name)) -
                Number(!['Downloads', 'Music', 'Desktop', 'Documents'].includes(b.name))
            )
            for (const entry of entries) {
              if (signal.aborted) break
              p.visited++
              const current = path.join(dir, entry.name)
              if (entry.isSymbolicLink() || TEMP.test(entry.name) || entry.name.startsWith('.')) {
                p.skipped++
                continue
              }
              if (entry.isDirectory()) {
                if (
                  EXCLUDED.has(entry.name.toLowerCase()) ||
                  SYSTEM_DIRECTORIES.has(current.toLowerCase()) ||
                  PACKAGE.test(entry.name)
                ) {
                  p.skipped++
                  this.issue(current, 'Excluded folder or managed bundle.')
                  continue
                }
                this.db.enqueue(p.id, source.id, current)
              } else if (
                entry.isFile() &&
                AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
              ) {
                await this.file(source, current, signal)
                p.audio++
              }
              if (p.visited > 1000000)
                throw new Error(
                  'Scan reached the one-million-entry safety limit. Choose a smaller source scope.'
                )
              if (Date.now() - lastEmit > 400) {
                this.emit()
                lastEmit = Date.now()
                await new Promise(r => setImmediate(r))
              }
            }
            if (!signal.aborted) this.db.directoryDone(p.id, source.id, dir)
          } catch (e) {
            complete = false
            partial = true
            this.issue(dir, e instanceof Error ? e.message : String(e))
            this.db.directoryDone(p.id, source.id, dir)
          }
        }
        if (!signal.aborted) this.db.finishSource(source.id, p.id, complete)
        if (!complete) {
          partial = true
          if (!p.incompleteSourceIds.includes(source.id)) p.incompleteSourceIds.push(source.id)
        }
      }
      p.status = signal.aborted ? 'cancelled' : 'completed'
      p.coverage = signal.aborted || partial ? 'partial' : 'complete'
    } catch (e) {
      p.status = 'failed'
      p.coverage = 'partial'
      this.issue(p.currentPath, e instanceof Error ? e.message : String(e))
    } finally {
      p.finishedAt = new Date().toISOString()
      this.db.db
        .prepare("UPDATE sources SET status=? WHERE status='scanning'")
        .run(p.status === 'completed' ? 'ready' : p.status)
      this.abort = null
      this.emit()
    }
  }
  private async file(source: Source, filePath: string, signal: AbortSignal) {
    const p = this.progress!
    try {
      // Realpath containment and no-follow lstat/resource checks precede all content reads.
      const actual = await realpath(filePath)
      if (!within(source.path, actual)) {
        p.skipped++
        return
      }
      const info = await this.native.inspect(filePath)
      if (!info.regular || info.alias) {
        p.skipped++
        return
      }
      p.bytes += info.size
      const key = physicalKey(info)
      const sig = signature(info)
      const existing = this.db.resolvePhysical(key, filePath)
      if (existing && ['trashed', 'removed'].includes(existing.availability)) {
        p.skipped++
        return
      }
      const unavailable = info.cloudOnly || info.availabilityUnknown
      const previous = existing ? this.db.get(existing.id) : undefined
      const cachedFailure = existing && ['corrupt', 'unsupported'].includes(existing.availability)
      const cachedMetadata =
        previous?.format &&
        !previous.metadataError &&
        ['available', 'missing', 'unavailable'].includes(previous.availability)
      if (
        existing &&
        existing.signature === sig &&
        previous?.tags.organizerParserRevision === PARSER_REVISION &&
        !unavailable &&
        (cachedFailure || cachedMetadata)
      ) {
        this.db.observe(existing.id, source.id, filePath, p.id)
        this.db.db
          .prepare(
            "UPDATE files SET path=?,filename=?,sourceId=?,availability=? WHERE id=? AND availability NOT IN ('trashed','removed')"
          )
          .run(
            filePath,
            path.basename(filePath),
            source.id,
            cachedFailure ? existing.availability : 'available',
            existing.id
          )
        if (cachedFailure && previous?.metadataError) this.issue(filePath, previous.metadataError)
        p.unchanged++
        return
      }
      let metadata: any = previous
        ? {
            artist: previous.artist,
            title: previous.title,
            bpm: previous.bpm,
            year: previous.year,
            genre: previous.genre,
            duration: previous.duration,
            format: previous.format,
            bitrate: previous.bitrate,
            sampleRate: previous.sampleRate,
            key: previous.key,
            tags: previous.tags,
          }
        : {
            artist: null,
            title: null,
            bpm: null,
            year: null,
            genre: null,
            duration: null,
            format: null,
            bitrate: null,
            sampleRate: null,
            key: null,
            tags: {},
          }
      let error: string | null = null
      let availability: Track['availability'] = 'available'
      if (unavailable) {
        availability = info.cloudOnly ? 'cloud-only' : 'unavailable'
        error = 'Contents were not opened: local availability could not be established.'
      } else {
        try {
          await access(filePath, constants.R_OK)
          metadata = await this.metadata.read(filePath, signal, info)
          const after = await this.native.inspect(filePath)
          if (signature(after) !== sig || physicalKey(after) !== key) {
            availability = 'changed'
            error = 'File changed during inspection; retry after the download finishes.'
          }
        } catch (e) {
          if (signal.aborted) return
          if (e instanceof Error && 'partial' in e && e.partial) metadata = e.partial
          error = e instanceof Error ? e.message : String(e)
          availability = /unsupported|format|type/i.test(error) ? 'unsupported' : 'corrupt'
        }
      }
      if (error) this.issue(filePath, error)
      const now = new Date().toISOString()
      const result = this.db.register(
        {
          id: existing?.id || randomUUID(),
          physicalKey: key,
          signature: sig,
          path: filePath,
          filename: path.basename(filePath),
          sourceId: source.id,
          size: info.size,
          availability,
          metadataError: error,
          addedAt: previous?.addedAt || now,
          updatedAt: now,
          ...metadata,
          tags: { ...metadata.tags, organizerParserRevision: PARSER_REVISION },
        },
        p.id
      )
      result === 'new' ? p.newFiles++ : p.changed++
    } catch (e) {
      if (!signal.aborted) this.issue(filePath, e instanceof Error ? e.message : String(e))
    }
  }
}

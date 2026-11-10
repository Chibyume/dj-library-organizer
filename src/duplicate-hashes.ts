import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { LibraryDB } from './db'
import { NativeHelper } from './native'
import { physicalKey, signature, within } from './scanner'
import type { Track } from './shared'
import type { DuplicateJob } from './preparation-types'
export type CatalogFile = Track & { signature: string; physicalKey: string }
export async function validateAudio(db: LibraryDB, helper: NativeHelper, track: CatalogFile) {
  const roots = db.db.prepare('SELECT path FROM sources WHERE enabled=1').all() as {
    path: string
  }[]
  const actual = await realpath(track.path)
  if (actual !== track.path || !roots.some(root => within(root.path, actual)))
    throw new Error('Source access changed. Run Smart Scan.')
  const info = await helper.inspect(actual)
  if (!info.regular || info.alias || info.cloudOnly || info.availabilityUnknown)
    throw new Error('File is not safely available locally.')
  if (physicalKey(info) !== track.physicalKey || signature(info) !== track.signature)
    throw new Error('File changed. Run Smart Scan.')
  return info
}
export class DuplicateHashes {
  private task: Promise<void> | null = null
  private stopped = false
  private worker: Worker | null = null
  constructor(
    private db: LibraryDB,
    private helper: NativeHelper,
    private workerPath: string,
    private notify: () => void
  ) {
    const job = this.state()
    if (job?.status === 'running') this.save({ ...job, status: 'interrupted', current: '' })
  }
  get running() {
    return this.task !== null
  }
  state(): DuplicateJob | null {
    const row = this.db.db.prepare('SELECT data FROM duplicate_job WHERE id=1').get() as
      { data: string } | undefined
    return row ? JSON.parse(row.data) : null
  }
  private save(job: DuplicateJob) {
    this.db.db
      .prepare(
        'INSERT INTO duplicate_job VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'
      )
      .run(JSON.stringify(job))
    this.notify()
  }
  start() {
    if (this.task) return
    this.stopped = false
    this.task = this.run().finally(() => {
      this.task = null
      this.notify()
    })
  }
  pause() {
    this.stopped = true
    void this.worker?.terminate()
  }
  async close() {
    this.pause()
    await this.task
  }
  async wait() {
    await this.task
  }
  hash(track: CatalogFile, expected: Awaited<ReturnType<typeof validateAudio>>): Promise<string> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, {
        workerData: { path: track.path, expected },
        resourceLimits: { maxOldGenerationSizeMb: 96 },
      })
      this.worker = worker
      let settled = false
      const finish = (error: Error | null, hash?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.worker = null
        void worker.terminate()
        error ? reject(error) : resolve(hash!)
      }
      const timer = setTimeout(
        () => finish(new Error('Full-file check timed out. File remains unchecked.')),
        180000
      )
      worker.once('message', message =>
        finish(message.error ? new Error(message.error) : null, message.hash)
      )
      worker.once('error', error =>
        finish(error instanceof Error ? error : new Error('File check failed.'))
      )
      worker.once('exit', () =>
        finish(new Error(this.stopped ? 'Paused.' : 'File check stopped unexpectedly.'))
      )
    })
  }
  async verifyFresh(track: CatalogFile, expectedHash: string) {
    if (track.size > 32 * 1024 ** 3) throw new Error('File exceeds the full-file check limit.')
    const info = await validateAudio(this.db, this.helper, track)
    if ((await this.hash(track, info)) !== expectedHash)
      throw new Error('File content changed; cleanup skipped.')
    return validateAudio(this.db, this.helper, track)
  }
  private async run() {
    const rows = this.db.db
      .prepare(
        "SELECT id FROM files WHERE availability='available' AND review!='Excluded' ORDER BY id"
      )
      .all() as { id: string }[]
    const job: DuplicateJob = {
      status: 'running',
      checked: 0,
      cached: 0,
      failed: 0,
      total: rows.length,
      current: '',
      error: null,
    }
    this.save(job)
    try {
      for (const row of rows) {
        if (this.stopped) break
        const track = this.db.get(row.id) as CatalogFile
        job.current = track.title || track.filename
        this.save(job)
        try {
          if (track.size > 32 * 1024 ** 3)
            throw new Error('File exceeds the 32 GB full-file check limit.')
          const info = await validateAudio(this.db, this.helper, track)
          if (this.stopped) break
          const cached = this.db.db
            .prepare(
              'SELECT hash FROM file_hashes WHERE fileId=? AND signature=? AND physicalKey=? AND hash IS NOT NULL'
            )
            .get(track.id, track.signature, track.physicalKey)
          if (cached) job.cached++
          else {
            const hash = await this.hash(track, info)
            await validateAudio(this.db, this.helper, track)
            if (this.stopped) break
            this.db.db
              .prepare(
                'INSERT INTO file_hashes VALUES(?,?,?,?,?,?) ON CONFLICT(fileId) DO UPDATE SET signature=excluded.signature,physicalKey=excluded.physicalKey,hash=excluded.hash,error=NULL,checkedAt=excluded.checkedAt'
              )
              .run(
                track.id,
                track.signature,
                track.physicalKey,
                hash,
                null,
                new Date().toISOString()
              )
          }
          job.checked++
        } catch (error) {
          if (this.stopped) break
          job.failed++
          this.db.db
            .prepare(
              'INSERT INTO file_hashes VALUES(?,?,?,?,?,?) ON CONFLICT(fileId) DO UPDATE SET signature=excluded.signature,physicalKey=excluded.physicalKey,hash=NULL,error=excluded.error,checkedAt=excluded.checkedAt'
            )
            .run(
              track.id,
              track.signature,
              track.physicalKey,
              null,
              error instanceof Error ? error.message : 'Check failed.',
              new Date().toISOString()
            )
        }
        await new Promise<void>(r => setImmediate(r))
      }
      job.status = this.stopped ? 'paused' : 'completed'
    } catch (error) {
      job.status = 'failed'
      job.error = error instanceof Error ? error.message : 'Check failed.'
    }
    job.current = ''
    this.save(job)
  }
}

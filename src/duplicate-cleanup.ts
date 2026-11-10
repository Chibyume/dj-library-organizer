import { randomUUID, createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  chmodSync,
  readdirSync,
  lstatSync,
} from 'node:fs'
import path from 'node:path'
import { realpath, lstat } from 'node:fs/promises'
import { LibraryDB } from './db'
import { NativeHelper } from './native'
import { DuplicateHashes, validateAudio, type CatalogFile } from './duplicate-hashes'
import { Preparation } from './preparation'
import { signature, physicalKey, within } from './scanner'
import type { CleanupPreview, CleanupState } from './preparation-types'
import type { TrashJournalEntry } from './track-trash-types'
type Selection = Awaited<ReturnType<Preparation['cleanupCandidates']>>
type Entry = {
  file: CatalogFile
  keeper: CatalogFile
  hash: string
  status: 'pending' | 'moving' | 'trashed' | 'restoring' | 'restored' | 'failed' | 'uncertain'
  trashPath?: string
  error?: string
}
type Journal = {
  version: 1
  decisions: Selection['decisions']
  state: CleanupState
  entries: Entry[]
  backup: string
  createdAt: string
  includeReferenced?: boolean
  referencedExtras?: number
}
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export class DuplicateCleanup {
  private plan: {
    token: string
    selection: Selection
    fingerprint: string
    expires: number
  } | null = null
  private task: Promise<void> | null = null
  private preparing = false
  private cancelled = false
  private journal: Journal | null = null
  private directory: string
  private restoreIds: Set<string> | null = null
  constructor(
    private db: LibraryDB,
    private helper: NativeHelper,
    private hashes: DuplicateHashes,
    private preparation: Preparation,
    private notify: () => void
  ) {
    this.directory = path.join(db.directory, 'duplicate-cleanup')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    try {
      const id = readFileSync(path.join(this.directory, 'latest'), 'utf8')
      if (!uuid.test(id)) throw Error('Invalid cleanup journal.')
      const saved = JSON.parse(
        readFileSync(path.join(this.directory, id + '.json'), 'utf8')
      ) as Journal
      if (
        saved.version !== 1 ||
        saved.state.id !== id ||
        !Array.isArray(saved.entries) ||
        saved.entries.length > 100000
      )
        throw Error('Invalid cleanup journal.')
      this.journal = saved
      if (['running', 'restoring'].includes(saved.state.status)) {
        saved.state.status = 'interrupted'
        saved.state.current = ''
        saved.state.error =
          'Cleanup was interrupted. Completed moves are recorded; uncertain moves are not repeated automatically.'
        for (const e of saved.entries)
          if (['moving', 'restoring'].includes(e.status)) e.status = 'uncertain'
        this.save()
      }
    } catch {
      /* No valid saved batch: leave all source files untouched. */
    }
  }
  private readJournal(id: string): Journal {
    if (!uuid.test(id)) throw Error('Invalid cleanup batch.')
    const file = path.join(this.directory, id + '.json')
    const info = lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 ** 2)
      throw Error('Invalid cleanup journal.')
    const j = JSON.parse(readFileSync(file, 'utf8')) as Journal
    if (
      j.version !== 1 ||
      typeof j.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(j.createdAt)) ||
      j.state?.id !== id ||
      !Array.isArray(j.entries) ||
      j.entries.length > 100000
    )
      throw Error('Invalid cleanup journal.')
    for (const entry of j.entries) {
      if (
        !entry ||
        !entry.file ||
        !uuid.test(entry.file.id) ||
        typeof entry.file.path !== 'string' ||
        !path.isAbsolute(entry.file.path) ||
        path.normalize(entry.file.path) !== entry.file.path ||
        typeof entry.file.signature !== 'string' ||
        typeof entry.file.physicalKey !== 'string' ||
        !Number.isFinite(entry.file.size) ||
        entry.file.size < 0 ||
        typeof entry.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.hash) ||
        !['pending', 'moving', 'trashed', 'restoring', 'restored', 'failed', 'uncertain'].includes(
          entry.status
        ) ||
        (entry.trashPath !== undefined &&
          (typeof entry.trashPath !== 'string' ||
            !path.isAbsolute(entry.trashPath) ||
            path.normalize(entry.trashPath) !== entry.trashPath))
      )
        throw Error('Invalid cleanup recovery entry.')
    }
    return j
  }
  entries(): TrashJournalEntry[] {
    const entries: TrashJournalEntry[] = []
    for (const name of readdirSync(this.directory)
      .filter(value => value.endsWith('.json') && uuid.test(value.slice(0, -5)))
      .slice(0, 1000)) {
      try {
        const journal = this.readJournal(name.slice(0, -5))
        entries.push(
          ...journal.entries.map(entry => ({
            id: entry.file.id,
            path: entry.file.path,
            signature: entry.file.signature,
            physicalKey: entry.file.physicalKey,
            batchId: journal.state.id,
            removedAt: journal.createdAt,
            status: entry.status,
            trashPath: entry.trashPath,
            reason: entry.error,
          }))
        )
      } catch {
        /* Invalid journals provide no actionable recovery paths. */
      }
    }
    return entries.sort((a, b) => b.removedAt.localeCompare(a.removedAt))
  }
  history() {
    const names = readdirSync(this.directory)
      .filter(n => n.endsWith('.json') && uuid.test(n.slice(0, -5)))
      .slice(0, 1000)
    const records: {
      id: string
      createdAt: string
      trashed: number
      restored: number
      status: CleanupState['status']
    }[] = []
    for (const name of names) {
      try {
        const j = this.readJournal(name.slice(0, -5))
        records.push({
          id: j.state.id,
          createdAt: j.createdAt,
          trashed: j.state.trashed,
          restored: j.state.restored,
          status: j.state.status,
        })
      } catch {
        /* Invalid journals are never offered as recovery actions. */
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50)
  }
  get running() {
    return this.preparing || this.task !== null
  }
  state() {
    return this.journal ? { ...this.journal.state } : null
  }
  private atomic(file: string, data: string) {
    const tmp = file + '.' + randomUUID() + '.tmp'
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
    const directory = openSync(path.dirname(file), 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  }
  private save() {
    if (this.journal)
      this.atomic(
        path.join(this.directory, this.journal.state.id + '.json'),
        JSON.stringify(this.journal, null, 2)
      )
  }
  pause() {
    this.cancelled = true
    this.hashes.pause()
  }
  async wait() {
    await this.task
  }
  async close() {
    this.pause()
    await this.task
    while (this.preparing) await new Promise(r => setTimeout(r, 10))
  }
  private idle() {
    if (this.running || this.hashes.running || this.preparation.running)
      throw Error('Finish the current cleanup or preparation first.')
  }
  async preview(includeReferenced = false): Promise<CleanupPreview> {
    this.idle()
    this.preparing = true
    try {
      const selection = await this.preparation.cleanupCandidates(includeReferenced)
      const token = randomUUID()
      this.plan = {
        token,
        selection,
        fingerprint: digest(selection),
        expires: Date.now() + 15 * 60 * 1000,
      }
      return {
        token,
        includeReferenced,
        referencedExtras: selection.referencedExtras,
        files: selection.items.length,
        bytes: selection.items.reduce((n, i) => n + i.file.size, 0),
        protected: selection.protected,
        examples: selection.items.slice(0, 20).map(i => ({
          title: i.file.title || i.file.filename,
          path: i.file.path,
          keeper: i.keeper.path,
        })),
      }
    } finally {
      this.preparing = false
    }
  }
  async start(token: string) {
    this.idle()
    this.preparing = true
    try {
      const plan = this.plan
      if (!plan || plan.token !== token || Date.now() > plan.expires)
        throw Error('Preview cleanup again before moving files.')
      const fresh = await this.preparation.cleanupCandidates(plan.selection.includeReferenced)
      if (digest(fresh) !== plan.fingerprint)
        throw Error('Duplicate choices or library evidence changed. Preview cleanup again.')
      if (!fresh.items.length) throw Error('No verified extras are eligible.')
      const id = randomUUID(),
        backup = 'before-duplicate-cleanup-' + id + '.sqlite'
      await this.db.backup(path.join(this.db.directory, backup))
      chmodSync(path.join(this.db.directory, backup), 0o600)
      this.journal = {
        version: 1,
        includeReferenced: fresh.includeReferenced,
        referencedExtras: fresh.referencedExtras,
        decisions: fresh.decisions,
        backup,
        createdAt: new Date().toISOString(),
        state: {
          id,
          status: 'running',
          total: fresh.items.length,
          trashed: 0,
          restored: 0,
          failed: 0,
          bytes: 0,
          current: '',
          error: null,
        },
        entries: fresh.items.map(i => ({ ...i, status: 'pending' })),
      }
      this.save()
      this.atomic(path.join(this.directory, 'latest'), id)
      this.plan = null
      this.cancelled = false
      this.task = this.run().finally(() => {
        this.task = null
        this.notify()
      })
    } finally {
      this.preparing = false
    }
  }
  private async run() {
    const j = this.journal!
    const verifiedKeepers = new Set<string>()
    try {
      for (const e of j.entries) {
        if (this.cancelled) break
        j.state.current = e.file.title || e.file.filename
        this.notify()
        try {
          if (!verifiedKeepers.has(e.keeper.id)) {
            await this.hashes.verifyFresh(e.keeper, e.hash)
            verifiedKeepers.add(e.keeper.id)
          }
          const expected = await this.hashes.verifyFresh(e.file, e.hash)
          await validateAudio(this.db, this.helper, e.keeper)
          if (this.cancelled) break
          e.status = 'moving'
          this.save()
          const moved = await this.helper.call<{ path: string }>('trash', {
            path: e.file.path,
            expected,
          })
          if (!moved.path || !path.isAbsolute(moved.path))
            throw Error('Trash destination was not returned.')
          e.trashPath = moved.path
          e.status = 'trashed'
          j.state.trashed++
          j.state.bytes += e.file.size
          this.save()
          this.db.db.transaction(() => {
            this.db.db
              .prepare(
                "UPDATE files SET availability='trashed',revision=revision+1 WHERE id=? AND signature=? AND physicalKey=?"
              )
              .run(e.file.id, e.file.signature, e.file.physicalKey)
            this.db.db
              .prepare('UPDATE locations SET available=0 WHERE fileId=? AND path=?')
              .run(e.file.id, e.file.path)
            this.db.db.prepare('DELETE FROM playlist_approvals WHERE fileId=?').run(e.file.id)
          })()
        } catch (error) {
          if (this.cancelled && e.status === 'pending') break
          e.error = error instanceof Error ? error.message : 'Cleanup failed.'
          j.state.failed++
          if (e.status === 'moving') {
            e.status = 'uncertain'
            this.save()
            throw Error(
              'A Trash operation could not be confirmed. Cleanup stopped; inspect the saved journal.'
            )
          }
          if (e.status === 'trashed') {
            this.save()
            throw Error(
              'File is in Trash but catalog update failed. Cleanup stopped; use the saved journal.'
            )
          }
          e.status = 'failed'
          this.save()
        }
        this.notify()
        await new Promise<void>(r => setImmediate(r))
      }
      j.state.status = this.cancelled ? 'paused' : 'completed'
    } catch (error) {
      j.state.status = 'failed'
      j.state.error = error instanceof Error ? error.message : 'Cleanup failed.'
    }
    try {
      await this.preparation.reconcileCleanupChoices(j.decisions || [])
    } catch {
      j.state.error = 'Some duplicate choices need refreshing after cleanup.'
    }
    j.state.current = ''
    this.save()
  }
  async restore(id: string, ids?: string[]) {
    this.idle()
    const j = this.readJournal(id)
    if (
      ids &&
      (!ids.length ||
        ids.length > 1000 ||
        new Set(ids).size !== ids.length ||
        ids.some(
          fileId => !uuid.test(fileId) || !j.entries.some(entry => entry.file.id === fileId)
        ))
    )
      throw Error('Invalid selected cleanup recovery files.')
    const selected = ids ? new Set(ids) : null
    if (['running', 'restoring'].includes(j.state.status))
      throw Error('Interrupted batch needs journal inspection before restoring.')
    if (
      !j.entries.some(
        e =>
          (!selected || selected.has(e.file.id)) &&
          (e.status === 'trashed' ||
            (['restored', 'uncertain'].includes(e.status) &&
              this.db.get(e.file.id)?.availability === 'trashed'))
      )
    )
      throw Error('No confirmed moved files remain to restore.')
    this.journal = j
    this.restoreIds = selected
    this.atomic(path.join(this.directory, 'latest'), id)
    this.cancelled = false
    j.state.status = 'restoring'
    j.state.error = null
    this.save()
    this.task = this.runRestore().finally(() => {
      this.task = null
      this.notify()
    })
  }
  private applyRestoredCatalog(entry: Entry, info: Awaited<ReturnType<NativeHelper['inspect']>>) {
    this.db.db.transaction(() => {
      const changed = this.db.db
        .prepare(
          "UPDATE files SET availability='available',physicalKey=?,signature=?,revision=revision+1 WHERE id=? AND path=? AND signature=? AND physicalKey=? AND availability='trashed'"
        )
        .run(
          physicalKey(info),
          signature(info),
          entry.file.id,
          entry.file.path,
          entry.file.signature,
          entry.file.physicalKey
        )
      if (changed.changes !== 1)
        throw Error(
          'The restored file is at its original path, but its catalog identity changed. Refresh Trash before retrying catalog recovery.'
        )
      this.db.db
        .prepare('UPDATE locations SET available=1 WHERE fileId=? AND path=?')
        .run(entry.file.id, entry.file.path)
      this.db.db
        .prepare('UPDATE file_hashes SET signature=?,physicalKey=? WHERE fileId=? AND hash=?')
        .run(signature(info), physicalKey(info), entry.file.id, entry.hash)
      for (const table of ['research_approved', 'era_years', 'preview_evidence'])
        this.db.db
          .prepare(`UPDATE ${table} SET signature=? WHERE fileId=? AND signature=?`)
          .run(signature(info), entry.file.id, entry.file.signature)
    })()
  }
  private async runRestore() {
    const j = this.journal!
    try {
      for (const e of j.entries) {
        if (this.cancelled) break
        if (this.restoreIds && !this.restoreIds.has(e.file.id)) continue
        if (!['trashed', 'restored', 'uncertain'].includes(e.status)) continue
        j.state.current = e.file.title || e.file.filename
        this.notify()
        try {
          const row = this.db.get(e.file.id) as CatalogFile | undefined
          if (
            !row ||
            row.path !== e.file.path ||
            row.signature !== e.file.signature ||
            row.physicalKey !== e.file.physicalKey ||
            row.availability !== 'trashed'
          )
            throw Error('Original catalog location changed. Restore skipped.')
          const parent = await realpath(path.dirname(e.file.path))
          if (
            parent !== path.dirname(e.file.path) ||
            !this.db.sources().some(s => s.enabled && within(s.path, e.file.path))
          )
            throw Error('Restore source is unavailable or paused.')
          if (['restored', 'uncertain'].includes(e.status)) {
            if ((await realpath(e.file.path)) !== e.file.path)
              throw Error('The original path changed. No restore move was repeated.')
            const original = await this.helper.inspect(e.file.path)
            if (
              !original.regular ||
              original.links !== 1 ||
              original.alias ||
              original.cloudOnly ||
              original.availabilityUnknown ||
              original.size > 32 * 1024 ** 3 ||
              physicalKey(original) !== e.file.physicalKey ||
              (await this.hashes.hash(e.file, original)) !== e.hash
            )
              throw Error(
                'The original path does not contain the previously moved file. No file was overwritten.'
              )
            const counted = e.status === 'restored'
            this.applyRestoredCatalog(e, original)
            e.status = 'restored'
            e.error = undefined
            if (!counted) j.state.restored++
            this.save()
            continue
          }
          if (!e.trashPath) throw Error('Trash location is unknown.')
          const expected = await this.helper.inspect(e.trashPath)
          if (
            expected.size > 32 * 1024 ** 3 ||
            !expected.regular ||
            expected.alias ||
            expected.cloudOnly ||
            expected.availabilityUnknown
          )
            throw Error('Trash file is not available.')
          if ((await this.hashes.hash({ ...e.file, path: e.trashPath }, expected)) !== e.hash)
            throw Error('Trash contents changed; restore skipped.')
          if (this.cancelled) break
          const occupied = await lstat(e.file.path).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return false
              throw error
            }
          )
          if (occupied) throw Error('Original path is occupied; no file was overwritten.')
          e.status = 'restoring'
          this.save()
          await this.helper.call('restore', {
            path: e.trashPath,
            destination: e.file.path,
            expected,
          })
          e.status = 'restored'
          j.state.restored++
          this.save()
          const info = await this.helper.inspect(e.file.path)
          this.applyRestoredCatalog(e, info)
          e.error = undefined
          this.save()
        } catch (error) {
          e.error = error instanceof Error ? error.message : 'Restore failed.'
          j.state.error = e.error
          j.state.failed++
          if (e.status === 'restoring') {
            e.status = 'uncertain'
            throw error
          }
          this.save()
        }
        this.notify()
      }
      j.state.status = this.cancelled
        ? 'paused'
        : j.entries.some(e => e.status === 'uncertain' || (e.status === 'trashed' && !!e.error))
          ? 'failed'
          : j.entries.every(e => e.status === 'restored')
            ? 'restored'
            : 'completed'
    } catch (error) {
      j.state.status = 'failed'
      j.state.error = error instanceof Error ? error.message : 'Restore failed.'
    }
    try {
      await this.preparation.reconcileCleanupChoices(j.decisions || [])
    } catch {
      j.state.error = 'Some duplicate choices need refreshing after cleanup.'
    }
    j.state.current = ''
    this.save()
  }
}

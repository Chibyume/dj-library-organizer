import { randomUUID, createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
  constants,
  type BigIntStats,
} from 'node:fs'
import { lstat, realpath, open } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { LibraryDB } from './db'
import type { CatalogFile } from './duplicate-hashes'
import type { Inspection, NativeHelper } from './native'
import { physicalKey, signature, within } from './scanner'
import type {
  TrackTrashChange,
  TrackTrashFile,
  TrackTrashPreview,
  TrackTrashRecord,
  TrackTrashResult,
  TrashJournalEntry,
} from './track-trash-types'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const MAX_SELECTED = 1000
const MAX_JUNK = 10000
const MAX_JOURNAL_BYTES = 256 * 1024 ** 2
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const absolute = z
  .string()
  .min(1)
  .max(32768)
  .refine(value => path.isAbsolute(value) && path.normalize(value) === value)
const inspectionSchema = z.object({
  regular: z.boolean(),
  links: z.number().int().nonnegative(),
  directory: z.boolean(),
  package: z.boolean(),
  alias: z.boolean(),
  cloudOnly: z.boolean(),
  availabilityUnknown: z.boolean(),
  device: z.string(),
  inode: z.string(),
  birth: z.string(),
  size: z.number().nonnegative(),
  mtime: z.string(),
  ctime: z.string(),
  volume: z.string().nullable(),
})
const fileSchema = z.object({
  id: z.string().regex(uuid),
  revision: z.number().int().nonnegative(),
  title: z.string(),
  artist: z.string().nullable(),
  path: absolute,
  size: z.number().nonnegative(),
  rekordboxReferences: z.number().int().nonnegative(),
  exportReferences: z.number().int().nonnegative(),
  signature: z.string(),
  physicalKey: z.string(),
  sourceId: z.string().regex(uuid),
  availability: z.string(),
  expected: inspectionSchema.optional(),
  action: z.enum(['move-to-trash', 'remove-from-library']).default('move-to-trash'),
  reason: z.string().optional(),
  locationState: z.enum(['original-kept', 'unconfirmed']).optional(),
  removedAt: z.string().optional(),
  uncertain: z.boolean().optional(),
  catalogRestoredAt: z.string().optional(),
  reconcileEligible: z.boolean().optional(),
  junkScope: z.boolean().optional(),
  originalSHA256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  status: z.enum([
    'pending',
    'moving',
    'trashed',
    'restoring',
    'restored',
    'failed',
    'removed',
    'uncertain',
  ]),
  trashPath: absolute.optional(),
  trashExpected: inspectionSchema.optional(),
  error: z.string().optional(),
})
const journalSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(uuid),
  createdAt: z.iso.datetime(),
  status: z.enum(['running', 'restoring', 'completed', 'partial', 'interrupted', 'restored']),
  error: z.string().nullable(),
  backup: z.string().regex(/^before-track-trash-[a-f0-9-]+\.sqlite$/),
  entries: z.array(fileSchema).min(1).max(MAX_JUNK),
})
type Entry = z.infer<typeof fileSchema>
type Journal = z.infer<typeof journalSchema>
type Selection = { entries: Entry[]; snapshotImportedAt: string | null }
class JournalStorageError extends Error {}

/** Explicit selected-file moves only. No background cleanup or permanent deletion. */
export class TrackTrash {
  private directory: string
  private busy = false
  private plan: {
    token: string
    selection: Selection
    fingerprint: string
    expires: number
    scope: 'selected' | 'junk'
    membership?: string
  } | null = null

  constructor(
    private db: LibraryDB,
    private helper: NativeHelper,
    private notify: () => void
  ) {
    this.directory = path.join(db.directory, 'track-trash')
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.checkDirectory()
    // Never reissue a move after an uncertain helper outcome or interrupted app.
    for (const record of this.journals()) {
      const interrupted = ['running', 'restoring'].includes(record.status)
      if (interrupted) {
        record.status = 'interrupted'
        record.error =
          'The app closed during a file operation. Confirmed moves can be restored; uncertain moves are not retried.'
      }
      let changed = interrupted
      for (const entry of record.entries)
        if (['moving', 'restoring'].includes(entry.status)) {
          entry.status = 'uncertain'
          changed = true
        }
      for (const entry of record.entries) {
        if (entry.catalogRestoredAt || entry.reconcileEligible === false) continue
        if (!['failed', 'uncertain', 'removed'].includes(entry.status)) continue
        const row = this.sameRow(entry, false)
        if (!row || ['trashed', 'removed'].includes(row.availability)) continue
        this.db.removeFromLibrary(
          { id: row.id, revision: row.revision },
          entry.error || entry.reason || 'An earlier Trash operation could not be confirmed.',
          entry.locationState || 'unconfirmed'
        )
        entry.uncertain = entry.uncertain || entry.status === 'uncertain'
        entry.status = 'removed'
        entry.action = 'remove-from-library'
        entry.removedAt ||= record.createdAt
        entry.locationState ||= 'unconfirmed'
        changed = true
      }
      if (changed) this.save(record)
    }
  }

  get running() {
    return this.busy
  }
  async close() {
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 25))
  }

  private checkDirectory() {
    const info = lstatSync(this.directory)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      realpathSync(this.directory) !== this.directory
    )
      throw Error('Trash recovery directory is not a safe local directory.')
  }

  private idle() {
    if (this.busy) throw Error('Wait for the current Trash operation to finish.')
    if (this.db.db.prepare("SELECT 1 FROM scans WHERE status='running' LIMIT 1").get())
      throw Error('Finish or pause scanning before moving files to Trash.')
  }

  private atomic(destination: string, value: string) {
    this.checkDirectory()
    const temporary = destination + '.' + randomUUID() + '.tmp'
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, value)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, destination)
    const directory = openSync(this.directory, 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
  }

  private save(journal: Journal) {
    try {
      const data = JSON.stringify(journal, null, 2)
      if (Buffer.byteLength(data, 'utf8') > MAX_JOURNAL_BYTES)
        throw Error(
          'This Trash batch exceeds the recovery journal size limit. No further file operations can run for this batch.'
        )
      this.atomic(path.join(this.directory, journal.id + '.json'), data)
    } catch (error) {
      throw new JournalStorageError(
        error instanceof Error ? error.message : 'Trash recovery storage failed.'
      )
    }
  }

  private read(id: string): Journal {
    if (!uuid.test(id)) throw Error('Invalid Trash recovery batch.')
    this.checkDirectory()
    const file = path.join(this.directory, id + '.json')
    const info = lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JOURNAL_BYTES)
      throw Error('Invalid Trash recovery record.')
    const record = journalSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    if (
      record.id !== id ||
      new Set(record.entries.map(entry => entry.id)).size !== record.entries.length
    )
      throw Error('Invalid Trash recovery entries.')
    for (const entry of record.entries) {
      if (
        (entry.expected &&
          (physicalKey(entry.expected) !== entry.physicalKey ||
            signature(entry.expected) !== entry.signature ||
            entry.expected.size !== entry.size)) ||
        (!entry.expected && entry.action === 'move-to-trash') ||
        (entry.trashExpected &&
          (physicalKey(entry.trashExpected) !== entry.physicalKey ||
            entry.trashExpected.size !== entry.size ||
            entry.trashExpected.mtime !== entry.expected?.mtime))
      )
        throw Error('Trash recovery file identity is inconsistent.')
    }
    return record
  }

  private journals() {
    this.checkDirectory()
    const records: Journal[] = []
    for (const name of readdirSync(this.directory)
      .filter(value => value.endsWith('.json') && uuid.test(value.slice(0, -5)))
      .slice(0, 1000)) {
      try {
        records.push(this.read(name.slice(0, -5)))
      } catch {
        /* Invalid records never become file actions. */
      }
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  private record(journal: Journal): TrackTrashRecord {
    return {
      id: journal.id,
      createdAt: journal.createdAt,
      status: journal.status,
      selected: journal.entries.length,
      moved: journal.entries.filter(
        entry => !!entry.trashPath && ['trashed', 'restoring', 'restored'].includes(entry.status)
      ).length,
      removed: journal.entries.filter(
        entry =>
          entry.action === 'remove-from-library' && ['removed', 'restored'].includes(entry.status)
      ).length,
      restored: journal.entries.filter(entry => entry.status === 'restored').length,
      failed: journal.entries.filter(
        entry => entry.status === 'failed' || (entry.status !== 'removed' && !!entry.error)
      ).length,
      uncertain: journal.entries.filter(entry => entry.status === 'uncertain' || entry.uncertain)
        .length,
      bytes: journal.entries
        .filter(
          entry => !!entry.trashPath && ['trashed', 'restoring', 'restored'].includes(entry.status)
        )
        .reduce((sum, entry) => sum + entry.size, 0),
      error: journal.error,
    }
  }

  private publicFile(entry: Entry): TrackTrashFile {
    const {
      id,
      title,
      artist,
      path: filePath,
      size,
      rekordboxReferences,
      exportReferences,
      action,
      reason,
    } = entry
    return {
      id,
      title,
      artist,
      path: filePath,
      size,
      rekordboxReferences,
      exportReferences,
      action,
      reason,
    }
  }

  private result(journal: Journal): TrackTrashResult {
    return {
      ...this.record(journal),
      files: journal.entries.map(entry => ({
        ...this.publicFile(entry),
        status: entry.status,
        trashPath: entry.trashPath,
        error: entry.error,
        locationState: entry.locationState,
      })),
    }
  }

  history(): TrackTrashRecord[] {
    return this.journals()
      .slice(0, 50)
      .map(journal => this.record(journal))
  }

  entries(): TrashJournalEntry[] {
    return this.journals().flatMap(journal =>
      journal.entries.map(entry => ({
        id: entry.id,
        path: entry.path,
        signature: entry.signature,
        physicalKey: entry.physicalKey,
        batchId: journal.id,
        removedAt: entry.removedAt || journal.createdAt,
        status: entry.status,
        trashPath: entry.trashPath,
        reason: entry.error || entry.reason,
        locationState: entry.locationState,
      }))
    )
  }

  private sameRow(
    entry: Pick<Entry, 'id' | 'path' | 'signature' | 'physicalKey' | 'revision'> & {
      junkScope?: boolean
    },
    requireRevision = true
  ) {
    const row = this.db.get(entry.id) as CatalogFile | undefined
    return row &&
      row.path === entry.path &&
      row.signature === entry.signature &&
      row.physicalKey === entry.physicalKey &&
      (!entry.junkScope || row.category === '_JUNK') &&
      (!requireRevision || row.revision === entry.revision)
      ? row
      : undefined
  }

  private planFingerprint(selection: Selection) {
    return digest({
      snapshotImportedAt: selection.snapshotImportedAt,
      entries: selection.entries.map(entry => ({
        id: entry.id,
        revision: entry.revision,
        path: entry.path,
        signature: entry.signature,
        physicalKey: entry.physicalKey,
        sourceId: entry.sourceId,
        availability: entry.availability,
        size: entry.size,
        rekordboxReferences: entry.rekordboxReferences,
        exportReferences: entry.exportReferences,
      })),
    })
  }

  private journalCapacity(selection: Selection) {
    const initial = Buffer.byteLength(
      JSON.stringify({ entries: selection.entries }, null, 2),
      'utf8'
    )
    // Reserve space before any effect for native Trash destinations, follow-up
    // identity snapshots, error text, and later restoration metadata. Full
    // paths remain visible; oversized scopes fail instead of being truncated.
    const future = selection.entries.reduce(
      (bytes, entry) => bytes + 16 * 1024 + 2 * Buffer.byteLength(entry.path, 'utf8'),
      0
    )
    if (initial + future + 64 * 1024 > MAX_JOURNAL_BYTES)
      throw Error(
        'This Trash batch exceeds the safe recovery journal size limit. No batch was started; reduce Junk or select fewer files.'
      )
  }

  private references() {
    const snapshot = this.db.db
      .prepare('SELECT id,importedAt FROM rb_snapshots WHERE active=1')
      .get() as { id: string; importedAt: string } | undefined
    const refs = snapshot
      ? (this.db.db
          .prepare(
            'SELECT t.localPath,m.fileId,m.candidates FROM rb_tracks t LEFT JOIN rb_matches m ON m.snapshotId=t.snapshotId AND m.trackKey=t.trackKey WHERE t.snapshotId=?'
          )
          .all(snapshot.id) as {
          localPath: string | null
          fileId: string | null
          candidates: string | null
        }[])
      : []
    const exports = this.db.db.prepare('SELECT manifest FROM playlist_exports').all() as {
      manifest: string
    }[]
    return {
      snapshot,
      refs: refs.map(ref => ({
        ...ref,
        candidates: ref.candidates ? z.array(z.string()).parse(JSON.parse(ref.candidates)) : [],
      })),
      exports: exports.map(
        row =>
          z
            .object({
              tracks: z.array(
                z.object({
                  id: z.string().optional(),
                  path: z.string().optional(),
                })
              ),
            })
            .parse(JSON.parse(row.manifest)).tracks
      ),
    }
  }

  private async validate(
    entry: Pick<
      Entry,
      'id' | 'revision' | 'path' | 'signature' | 'physicalKey' | 'sourceId' | 'availability'
    > & { junkScope?: boolean }
  ) {
    const current = this.db.get(entry.id) as CatalogFile | undefined
    if (
      !current ||
      current.revision !== entry.revision ||
      current.path !== entry.path ||
      current.signature !== entry.signature ||
      current.physicalKey !== entry.physicalKey ||
      current.sourceId !== entry.sourceId ||
      current.availability !== entry.availability ||
      (entry.junkScope && current.category !== '_JUNK') ||
      ['trashed', 'removed'].includes(current.availability)
    )
      throw Error('A selected file changed. Close this dialog and select the tracks again.')
    const source = this.db.source(current.sourceId)
    if (
      !source?.enabled ||
      source.status !== 'ready' ||
      !within(source.path, current.path) ||
      source.path === current.path
    )
      throw Error("A selected file's source is paused or unavailable. Run Smart Scan first.")
    const canonical = await realpath(current.path)
    if (canonical !== current.path || (await realpath(source.path)) !== source.path)
      throw Error('Trash requires an original file path without symbolic links.')
    const local = await lstat(current.path)
    const info = await this.helper.inspect(current.path)
    if (
      !local.isFile() ||
      local.isSymbolicLink() ||
      local.nlink !== 1 ||
      !info.regular ||
      info.directory ||
      info.package ||
      info.alias ||
      info.links !== 1 ||
      info.cloudOnly ||
      info.availabilityUnknown
    )
      throw Error('Trash requires a local regular file with one hard link.')
    if (
      signature(info) !== entry.signature ||
      physicalKey(info) !== entry.physicalKey ||
      info.size !== current.size
    )
      throw Error('A selected file changed on disk. Run Smart Scan before moving it.')
    return info
  }

  private async selection(changes: TrackTrashChange[], junkScope = false): Promise<Selection> {
    const parsed = z
      .array(
        z
          .object({
            id: z.string().regex(uuid),
            revision: z.number().int().nonnegative(),
          })
          .strict()
      )
      .min(1)
      .max(junkScope ? MAX_JUNK : MAX_SELECTED)
      .parse(changes)
    if (new Set(parsed.map(change => change.id)).size !== parsed.length)
      throw Error('Select each file only once.')
    const references = this.references()
    const referenceIds = new Map<string, Set<number>>(),
      referencePaths = new Map<string, Set<number>>()
    const exportIds = new Map<string, Set<number>>(),
      exportPaths = new Map<string, Set<number>>()
    const add = (
      index: Map<string, Set<number>>,
      key: string | null | undefined,
      value: number
    ) => {
      if (!key) return
      const values = index.get(key) || new Set<number>()
      values.add(value)
      index.set(key, values)
    }
    references.refs.forEach((reference, index) => {
      add(referenceIds, reference.fileId, index)
      add(referencePaths, reference.localPath, index)
      for (const id of reference.candidates) add(referenceIds, id, index)
    })
    references.exports.forEach((tracks, index) => {
      for (const track of tracks) {
        add(exportIds, track.id, index)
        add(exportPaths, track.path, index)
      }
    })
    const count = (
      ids: Map<string, Set<number>>,
      paths: Map<string, Set<number>>,
      row: CatalogFile
    ) => new Set([...(ids.get(row.id) || []), ...(paths.get(row.path) || [])]).size
    const entries: Entry[] = []
    for (const change of parsed) {
      const row = this.db.get(change.id) as CatalogFile | undefined
      if (
        !row ||
        row.revision !== change.revision ||
        (junkScope && row.category !== '_JUNK') ||
        ['trashed', 'removed'].includes(row.availability)
      )
        throw Error('A selected track changed. Select the tracks again.')
      let expected: Inspection | undefined, reason: string | undefined
      try {
        expected = await this.validate({ ...row, junkScope })
      } catch (error) {
        if (!this.sameRow(row)) throw Error('A selected track changed. Select the tracks again.')
        reason =
          error instanceof Error
            ? error.message
            : 'This file cannot safely be moved to macOS Trash.'
      }
      entries.push({
        id: row.id,
        revision: row.revision,
        title: row.title || row.filename,
        artist: row.artist,
        path: row.path,
        size: row.size,
        signature: row.signature,
        physicalKey: row.physicalKey,
        sourceId: row.sourceId,
        availability: row.availability,
        expected,
        junkScope: junkScope || undefined,
        action: expected ? 'move-to-trash' : 'remove-from-library',
        reason,
        rekordboxReferences: count(referenceIds, referencePaths, row),
        exportReferences: count(exportIds, exportPaths, row),
        status: 'pending',
      })
      if (entries.length % 50 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    }
    return {
      entries,
      snapshotImportedAt: references.snapshot?.importedAt || null,
    }
  }

  private junkChanges() {
    const changes = this.db.db
      .prepare(
        "SELECT id,revision FROM files WHERE category='_JUNK' AND availability NOT IN ('trashed','removed') ORDER BY id LIMIT ?"
      )
      .all(MAX_JUNK + 1) as TrackTrashChange[]
    if (changes.length > MAX_JUNK)
      throw Error(
        `Junk contains more than ${MAX_JUNK.toLocaleString()} active files. This batch was not created; reduce Junk before trying again.`
      )
    if (!changes.length) throw Error('Junk has no active files to move to Trash.')
    return changes
  }

  private buildPreview(
    selection: Selection,
    scope: 'selected' | 'junk',
    membership?: string
  ): TrackTrashPreview {
    this.journalCapacity(selection)
    const token = randomUUID(),
      expires = Date.now() + 15 * 60 * 1000
    this.plan = {
      token,
      selection,
      fingerprint: this.planFingerprint(selection),
      expires,
      scope,
      membership,
    }
    return {
      token,
      scope,
      total: selection.entries.length,
      expiresAt: new Date(expires).toISOString(),
      files: selection.entries.map(entry => this.publicFile(entry)),
      bytes: selection.entries.reduce((sum, entry) => sum + entry.size, 0),
      rekordboxReferences: selection.entries.reduce(
        (sum, entry) => sum + entry.rekordboxReferences,
        0
      ),
      exportReferences: selection.entries.reduce((sum, entry) => sum + entry.exportReferences, 0),
      snapshotImportedAt: selection.snapshotImportedAt,
      catalogOnly: selection.entries.filter(entry => entry.action === 'remove-from-library').length,
    }
  }

  async previewJunk(): Promise<TrackTrashPreview> {
    this.idle()
    this.busy = true
    this.plan = null
    try {
      const changes = this.junkChanges(),
        membership = digest(changes)
      const selection = await this.selection(changes, true)
      if (digest(this.junkChanges()) !== membership)
        throw Error('Junk changed while checking the files. Preview all Junk again.')
      return this.buildPreview(selection, 'junk', membership)
    } finally {
      this.busy = false
    }
  }

  async preview(changes: TrackTrashChange[]): Promise<TrackTrashPreview> {
    this.idle()
    this.busy = true
    this.plan = null
    try {
      const selection = await this.selection(changes)
      return this.buildPreview(selection, 'selected')
    } finally {
      this.busy = false
    }
  }

  async start(token: string): Promise<TrackTrashResult> {
    this.idle()
    this.busy = true
    try {
      const plan = this.plan
      this.plan = null // Confirmation tokens are single-use, even if a freshness check fails.
      if (!plan || token !== plan.token || Date.now() > plan.expires)
        throw Error('Preview selected files again before moving them to Trash.')
      if (plan.scope === 'junk' && digest(this.junkChanges()) !== plan.membership)
        throw Error(
          'Junk membership or classifications changed. Preview all Junk again before confirming.'
        )
      const fresh = await this.selection(
        plan.selection.entries.map(({ id, revision }) => ({ id, revision })),
        plan.scope === 'junk'
      )
      if (plan.scope === 'junk' && digest(this.junkChanges()) !== plan.membership)
        throw Error('Junk changed while checking the files. Preview all Junk again.')
      if (this.planFingerprint(fresh) !== plan.fingerprint)
        throw Error('Files or known playlist references changed. Preview selected files again.')
      for (let index = 0; index < fresh.entries.length; index++) {
        if (plan.selection.entries[index]?.action === 'remove-from-library') {
          fresh.entries[index]!.action = 'remove-from-library'
          fresh.entries[index]!.reason = plan.selection.entries[index]!.reason
          fresh.entries[index]!.expected = undefined
        }
      }
      this.journalCapacity(fresh)
      const id = randomUUID(),
        backup = 'before-track-trash-' + id + '.sqlite'
      await this.db.backup(path.join(this.db.directory, backup))
      chmodSync(path.join(this.db.directory, backup), 0o600)
      const journal: Journal = {
        version: 1,
        id,
        backup,
        createdAt: new Date().toISOString(),
        status: 'running',
        error: null,
        entries: fresh.entries,
      }
      this.save(journal)
      for (const entry of journal.entries) {
        if (entry.action === 'remove-from-library') {
          await this.removeFallback(
            entry,
            entry.reason || 'The original file cannot safely be moved to macOS Trash.'
          )
          this.save(journal)
          this.notify()
          continue
        }
        try {
          const checked = await this.validate(entry)
          const proof = await this.hashVerified(entry.path, checked)
          entry.originalSHA256 = proof.hash
          const expected = proof.expected
          entry.status = 'moving'
          this.save(journal)
          const moved = await this.helper.call<{ path: string }>('trash', {
            path: entry.path,
            expected,
          })
          if (!moved.path || !path.isAbsolute(moved.path) || moved.path === entry.path)
            throw Error('macOS did not confirm a Trash destination.')
          entry.trashPath = moved.path
          entry.status = 'trashed'
          this.save(journal)
          const trashed = await this.helper.inspect(moved.path)
          this.availableFile(trashed)
          if (
            physicalKey(trashed) !== physicalKey(expected) ||
            trashed.size !== expected.size ||
            trashed.mtime !== expected.mtime
          )
            throw Error(
              'Trash file identity could not be confirmed. Its recorded destination needs checking before restoration.'
            )
          entry.trashExpected = trashed
          this.save(journal)
          this.markTrashed(entry)
        } catch (error) {
          if (error instanceof JournalStorageError) throw error
          const reason = error instanceof Error ? error.message : 'Could not move this file.'
          if (entry.status === 'trashed') {
            entry.error = reason
            // A confirmed native destination remains a real Trash item even if
            // its follow-up inspection failed. No other selected file depends
            // on it; preserve the path and continue independent files.
            this.markTrashed(entry)
          } else {
            await this.removeFallback(entry, reason, entry.status === 'moving')
          }
          this.save(journal)
        }
        this.notify()
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      journal.status = journal.entries.every(
        entry => ['trashed', 'removed'].includes(entry.status) && !entry.error
      )
        ? 'completed'
        : 'partial'
      this.save(journal)
      this.notify()
      return this.result(journal)
    } finally {
      this.busy = false
    }
  }

  private markTrashed(entry: Entry) {
    const row = this.sameRow(entry, false)
    if (row?.availability === 'trashed') return
    if (!row || row.revision !== entry.revision || row.availability !== entry.availability) {
      entry.error =
        'The file moved to Trash, but its catalog identity changed. The recorded path is preserved for manual checking.'
      return
    }
    this.db.db.transaction(() => {
      const result = this.db.db
        .prepare(
          "UPDATE files SET availability='trashed',revision=revision+1 WHERE id=? AND revision=? AND signature=? AND physicalKey=? AND path=?"
        )
        .run(entry.id, entry.revision, entry.signature, entry.physicalKey, entry.path)
      if (result.changes !== 1)
        throw Error('The catalog changed while recording a confirmed Trash move.')
      this.db.db
        .prepare('UPDATE locations SET available=0 WHERE fileId=? AND path=?')
        .run(entry.id, entry.path)
      this.db.db.prepare('DELETE FROM playlist_approvals WHERE fileId=?').run(entry.id)
    })()
  }

  private async originalLocation(entry: Entry): Promise<'original-kept' | 'unconfirmed'> {
    try {
      if ((await realpath(entry.path)) !== entry.path) return 'unconfirmed'
      const actual = await this.helper.inspect(entry.path)
      return actual.regular &&
        !actual.alias &&
        !actual.cloudOnly &&
        !actual.availabilityUnknown &&
        physicalKey(actual) === entry.physicalKey &&
        signature(actual) === entry.signature
        ? 'original-kept'
        : 'unconfirmed'
    } catch {
      return 'unconfirmed'
    }
  }

  private async removeFallback(entry: Entry, reason: string, uncertain = false) {
    const row = this.sameRow(entry)
    if (!row || row.availability !== entry.availability) {
      entry.status = 'failed'
      entry.reconcileEligible = false
      entry.error =
        'The selected catalog identity changed. This entry was left alone; select it again if you still want to remove it.'
      return
    }
    const locationState = await this.originalLocation(entry)
    const freshRow = this.sameRow(entry)
    if (!freshRow || freshRow.availability !== entry.availability) {
      entry.status = 'failed'
      entry.reconcileEligible = false
      entry.error = 'The selected catalog entry changed during the check. It was left alone.'
      return
    }
    // The DB method checks the exact current revision again inside its
    // transaction. There is no physical retry for this item, even if a helper
    // response was lost and the original cannot be located.
    try {
      this.db.removeFromLibrary({ id: entry.id, revision: entry.revision }, reason, locationState)
    } catch (error) {
      if (!this.sameRow(entry) || this.db.get(entry.id)?.availability !== entry.availability) {
        entry.status = 'failed'
        entry.reconcileEligible = false
        entry.error = 'The selected catalog entry changed and was left alone.'
        return
      }
      throw error
    }
    entry.action = 'remove-from-library'
    entry.status = 'removed'
    entry.reason = reason
    entry.error = undefined
    entry.locationState = locationState
    entry.removedAt = new Date().toISOString()
    entry.uncertain = uncertain && locationState === 'unconfirmed'
  }

  private restoreRemovedRow(row: CatalogFile) {
    const matching = (entry: Entry) =>
      entry.id === row.id &&
      entry.path === row.path &&
      entry.signature === row.signature &&
      entry.physicalKey === row.physicalKey &&
      !['trashed', 'restoring'].includes(entry.status)
    const restoredAt = new Date().toISOString()
    // Durable supersession precedes the DB restore. If the process closes
    // between them, startup must not repeat an old failed removal.
    for (const journal of this.journals()) {
      let changed = false
      for (const entry of journal.entries)
        if (matching(entry)) {
          entry.catalogRestoredAt = restoredAt
          changed = true
        }
      if (changed) this.save(journal)
    }
    this.db.restoreToLibrary({ id: row.id, revision: row.revision })
    for (const journal of this.journals()) {
      let changed = false
      for (const entry of journal.entries)
        if (matching(entry)) {
          entry.status = 'restored'
          entry.error = undefined
          entry.uncertain = false
          changed = true
        }
      if (changed) {
        if (journal.entries.every(entry => entry.status === 'restored')) journal.status = 'restored'
        this.save(journal)
      }
    }
    return restoredAt
  }

  restoreRemoved(change: TrackTrashChange) {
    this.idle()
    this.busy = true
    this.plan = null
    try {
      const row = this.db.get(change.id) as CatalogFile | undefined
      if (!row || row.revision !== change.revision || row.availability !== 'removed')
        throw Error('The removed entry changed. Refresh Trash and select it again.')
      this.restoreRemovedRow(row)
      this.notify()
    } finally {
      this.busy = false
    }
  }

  private nativeNanoseconds(value: string) {
    const parts = value.split(':')
    if (parts.length === 1 && /^-?\d+$/.test(value)) return BigInt(value)
    if (parts.length === 2 && /^-?\d+$/.test(parts[0]!) && /^\d{1,9}$/.test(parts[1]!))
      return BigInt(parts[0]!) * 1_000_000_000n + BigInt(parts[1]!)
    throw Error('The native file timestamp could not be validated.')
  }

  private descriptorMatches(stat: BigIntStats, expected: Inspection) {
    return (
      stat.isFile() &&
      stat.nlink === 1n &&
      BigInt.asIntN(32, stat.dev).toString() === expected.device &&
      String(stat.ino) === expected.inode &&
      stat.birthtimeNs === this.nativeNanoseconds(expected.birth) &&
      stat.size === BigInt(expected.size) &&
      stat.mtimeNs === this.nativeNanoseconds(expected.mtime) &&
      stat.ctimeNs === this.nativeNanoseconds(expected.ctime)
    )
  }

  /** Read only after an explicit move confirmation or explicit restoration. */
  private async hashVerified(filePath: string, expected: Inspection) {
    if (!Number.isSafeInteger(expected.size) || expected.size < 0 || expected.size > 32 * 1024 ** 3)
      throw Error('This file exceeds the 32 GB verified-read limit. Its original was left alone.')
    if ((await realpath(filePath)) !== filePath)
      throw Error('The verified-read path contains a symbolic link.')
    const before = await this.helper.inspect(filePath)
    this.availableFile(before)
    if (physicalKey(before) !== physicalKey(expected) || signature(before) !== signature(expected))
      throw Error('The file changed before its content could be verified.')
    const handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const first = await handle.stat({ bigint: true })
      if (!this.descriptorMatches(first, before))
        throw Error('The file identity changed before its content could be verified.')
      const hash = createHash('sha256'),
        buffer = Buffer.alloc(1024 * 1024)
      let position = 0
      while (position < before.size) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - position),
          position
        )
        if (!bytesRead) throw Error('The file was truncated while its content was being verified.')
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
      }
      const last = await handle.stat({ bigint: true })
      if (!this.descriptorMatches(last, before))
        throw Error('The file changed while its content was being verified.')
      const after = await this.helper.inspect(filePath)
      this.availableFile(after)
      if (
        (await realpath(filePath)) !== filePath ||
        physicalKey(after) !== physicalKey(before) ||
        signature(after) !== signature(before)
      )
        throw Error('The file path or contents changed during verification.')
      return { hash: hash.digest('hex'), expected: after }
    } finally {
      await handle.close()
    }
  }

  private availableFile(info: Inspection) {
    if (
      !info.regular ||
      info.links !== 1 ||
      info.directory ||
      info.package ||
      info.alias ||
      info.cloudOnly ||
      info.availabilityUnknown
    )
      throw Error('The recorded Trash file is not safely available locally.')
  }

  private applyRestoredCatalog(entry: Entry, info: Inspection) {
    this.db.db.transaction(() => {
      const changed = this.db.db
        .prepare(
          'UPDATE files SET availability=?,physicalKey=?,signature=?,revision=revision+1 WHERE id=? AND path=? AND signature=? AND physicalKey=?'
        )
        .run(
          entry.availability,
          physicalKey(info),
          signature(info),
          entry.id,
          entry.path,
          entry.signature,
          entry.physicalKey
        )
      if (changed.changes !== 1)
        throw Error(
          'The restored file is at its original path, but its catalog identity changed. Refresh Trash before retrying catalog recovery.'
        )
      this.db.db
        .prepare('UPDATE locations SET available=1 WHERE fileId=? AND path=?')
        .run(entry.id, entry.path)
      this.db.db.prepare('DELETE FROM file_hashes WHERE fileId=?').run(entry.id)
      for (const table of ['research_approved', 'era_years', 'preview_evidence'])
        this.db.db
          .prepare(`UPDATE ${table} SET signature=? WHERE fileId=? AND signature=?`)
          .run(signature(info), entry.id, entry.signature)
    })()
  }

  async restore(id: string, ids?: string[]): Promise<TrackTrashResult> {
    this.idle()
    this.busy = true
    this.plan = null
    try {
      const journal = this.read(id)
      const selected = ids
        ? new Set(z.array(z.string().regex(uuid)).min(1).max(1000).parse(ids))
        : null
      if (
        selected &&
        (selected.size !== ids!.length ||
          [...selected].some(fileId => !journal.entries.some(entry => entry.id === fileId)))
      )
        throw Error('Invalid selected Trash recovery files.')
      if (['running', 'restoring'].includes(journal.status))
        throw Error('This batch was interrupted. Restart the app before restoring confirmed moves.')
      if (
        !journal.entries.some(
          entry =>
            (!selected || selected.has(entry.id)) &&
            (['trashed', 'removed'].includes(entry.status) ||
              this.sameRow(entry, false)?.availability === 'removed' ||
              (['restored', 'uncertain'].includes(entry.status) &&
                this.sameRow(entry, false)?.availability === 'trashed'))
        )
      )
        throw Error('No confirmed files remain in Trash for this batch.')
      journal.status = 'restoring'
      journal.error = null
      this.save(journal)
      for (const entry of journal.entries) {
        if (selected && !selected.has(entry.id)) continue
        if (entry.status === 'removed' || this.sameRow(entry, false)?.availability === 'removed') {
          const row = this.sameRow(entry, false)
          if (!row || row.availability !== 'removed') {
            entry.error = 'The removed catalog identity changed. This entry was left alone.'
          } else {
            entry.catalogRestoredAt = this.restoreRemovedRow(row)
            entry.status = 'restored'
            entry.error = undefined
            entry.uncertain = false
          }
          this.save(journal)
          continue
        }
        if (!['trashed', 'restored', 'uncertain'].includes(entry.status)) continue
        try {
          const row = this.db.get(entry.id) as CatalogFile | undefined
          if (
            !row ||
            row.path !== entry.path ||
            row.sourceId !== entry.sourceId ||
            row.signature !== entry.signature ||
            row.physicalKey !== entry.physicalKey ||
            !['trashed', entry.availability].includes(row.availability)
          )
            throw Error('The original catalog identity changed. Restore skipped.')
          const source = this.db.source(entry.sourceId)
          if (
            !source?.enabled ||
            source.status !== 'ready' ||
            !within(source.path, entry.path) ||
            (await realpath(source.path)) !== source.path ||
            (await realpath(path.dirname(entry.path))) !== path.dirname(entry.path)
          )
            throw Error('The original source is paused, unavailable, or changed. Restore skipped.')
          if (['restored', 'uncertain'].includes(entry.status)) {
            const proof = entry.trashExpected || entry.expected
            if (!proof || (await realpath(entry.path)) !== entry.path)
              throw Error('The earlier restore outcome is unconfirmed. No file move was repeated.')
            let original = await this.helper.inspect(entry.path)
            this.availableFile(original)
            if (
              physicalKey(original) !== entry.physicalKey ||
              original.size !== entry.size ||
              original.mtime !== proof.mtime
            )
              throw Error(
                'The original path does not contain the previously moved file. No file was overwritten.'
              )
            if (entry.originalSHA256) {
              const proof = await this.hashVerified(entry.path, original)
              if (proof.hash !== entry.originalSHA256)
                throw Error(
                  'The restored file contents differ from the original verified file. Catalog recovery was skipped.'
                )
              original = proof.expected
            }
            this.applyRestoredCatalog(entry, original)
            entry.status = 'restored'
            entry.error = undefined
            entry.uncertain = false
            this.save(journal)
            continue
          }
          if (!entry.expected || !entry.trashPath || !entry.trashExpected)
            throw Error(
              'Trash identity was not fully confirmed. Restore this item with Finder after checking its recorded paths.'
            )
          if ((await realpath(entry.trashPath)) !== entry.trashPath)
            throw Error('The Trash path contains a symbolic link. Restore skipped.')
          let expected = await this.helper.inspect(entry.trashPath)
          this.availableFile(expected)
          if (
            physicalKey(expected) !== entry.physicalKey ||
            expected.size !== entry.size ||
            expected.mtime !== entry.trashExpected.mtime
          )
            throw Error('The Trash file changed. Restore skipped.')
          if (expected.ctime !== entry.trashExpected.ctime) {
            if (!entry.originalSHA256)
              throw Error(
                'The Trash file changed. This older batch has no original content proof; restore was skipped.'
              )
            const proof = await this.hashVerified(entry.trashPath, expected)
            if (proof.hash !== entry.originalSHA256)
              throw Error(
                'The Trash file contents differ from the original verified file. Restore skipped.'
              )
            expected = proof.expected
          }
          const occupied = await lstat(entry.path).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return false
              throw error
            }
          )
          if (occupied) throw Error('The original path is occupied. No file was overwritten.')
          entry.error = undefined
          entry.status = 'restoring'
          this.save(journal)
          const restored = await this.helper.call<{ path: string }>('restore', {
            path: entry.trashPath,
            destination: entry.path,
            expected,
          })
          if (restored.path !== entry.path)
            throw Error('macOS did not confirm the original restore destination.')
          entry.status = 'restored'
          this.save(journal)
          const info = await this.helper.inspect(entry.path)
          this.availableFile(info)
          if (
            physicalKey(info) !== physicalKey(expected) ||
            info.size !== expected.size ||
            info.mtime !== expected.mtime
          )
            throw Error('Restored file identity changed. Check this item before scanning.')
          this.applyRestoredCatalog(entry, info)
          entry.error = undefined
          this.save(journal)
        } catch (error) {
          if (error instanceof JournalStorageError) throw error
          entry.error = error instanceof Error ? error.message : 'Could not restore this file.'
          journal.error = entry.error
          if (entry.status === 'restoring') entry.status = 'uncertain'
          this.save(journal)
        }
        this.notify()
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      journal.status = journal.entries.every(
        entry =>
          entry.status === 'restored' &&
          !entry.error &&
          !['trashed', 'removed'].includes(this.db.get(entry.id)?.availability || '')
      )
        ? 'restored'
        : 'partial'
      this.save(journal)
      this.notify()
      return this.result(journal)
    } finally {
      this.busy = false
    }
  }
}

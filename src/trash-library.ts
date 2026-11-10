import { z } from 'zod'
import type { LibraryDB } from './db'
import type { NativeHelper } from './native'
import type { TrackTrash } from './track-trash'
import type { DuplicateCleanup } from './duplicate-cleanup'
import type { LibraryPage, LibraryQuery, Track } from './shared'
import type { CatalogFile } from './duplicate-hashes'
import type {
  TrackTrashChange,
  TrashJournalEntry,
  TrashLibraryInfo,
  TrashRestoreResult,
} from './track-trash-types'

type Recovery = TrashJournalEntry & { origin: 'selected' | 'duplicate' }

/** Browses app-managed removals, never the user's unrelated Finder Trash. */
export class TrashLibrary {
  private busy = false
  constructor(
    private db: LibraryDB,
    _helper: NativeHelper,
    private selected: TrackTrash,
    private duplicates: DuplicateCleanup
  ) {}

  get running() {
    return this.busy
  }
  async close() {
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 25))
  }

  private recoveries(): Recovery[] {
    return [
      ...this.selected.entries().map(entry => ({ ...entry, origin: 'selected' as const })),
      ...this.duplicates.entries().map(entry => ({ ...entry, origin: 'duplicate' as const })),
    ].sort((a, b) => b.removedAt.localeCompare(a.removedAt))
  }

  private recovery(track: CatalogFile, entries: Recovery[]) {
    return entries.find(
      entry =>
        entry.id === track.id &&
        entry.path === track.path &&
        entry.signature === track.signature &&
        entry.physicalKey === track.physicalKey &&
        entry.status !== 'pending' &&
        (entry.status !== 'restored' || track.availability === 'trashed')
    )
  }

  list(query: LibraryQuery): LibraryPage {
    const page = this.db.list({ ...query, view: 'trash' })
    const entries = this.recoveries()
    return {
      ...page,
      tracks: page.tracks.map(track => {
        const row = track as CatalogFile
        const recovery = this.recovery(row, entries)
        const removal = this.db.db
          .prepare('SELECT removedAt,reason,locationState FROM library_removals WHERE fileId=?')
          .get(row.id) as
          | {
              removedAt: string
              reason: string
              locationState: 'original-kept' | 'unconfirmed'
            }
          | undefined
        const trash: TrashLibraryInfo = {
          state:
            row.availability === 'removed'
              ? removal?.locationState || 'unconfirmed'
              : recovery && recovery.status !== 'trashed'
                ? 'unconfirmed'
                : 'in-trash',
          removedAt: removal?.removedAt || recovery?.removedAt || row.updatedAt,
          originalPath: row.path,
          trashPath: recovery?.trashPath,
          reason:
            removal?.reason ||
            recovery?.reason ||
            (!recovery?.trashPath
              ? 'No validated recovery path is saved for this item. Its original location and catalog record are retained; use Finder Trash if restoration is needed.'
              : undefined),
          batchId: recovery?.batchId,
          origin: recovery?.origin || 'catalog',
        }
        return { ...track, trash }
      }),
    }
  }

  async restoreSelected(changes: TrackTrashChange[]): Promise<TrashRestoreResult> {
    const parsed = z
      .array(z.object({ id: z.uuid(), revision: z.number().int().nonnegative() }).strict())
      .min(1)
      .max(1000)
      .parse(changes)
    if (new Set(parsed.map(change => change.id)).size !== parsed.length)
      throw Error('Select each Trash item only once.')
    if (this.busy || this.selected.running || this.duplicates.running)
      throw Error('Wait for the current Trash operation to finish.')
    this.busy = true
    const result: TrashRestoreResult = { restored: 0, failed: 0, errors: [] }
    try {
      const entries = this.recoveries()
      for (const change of parsed) {
        try {
          const row = this.db.get(change.id) as CatalogFile | undefined
          if (
            !row ||
            row.revision !== change.revision ||
            !['trashed', 'removed'].includes(row.availability)
          )
            throw Error('This Trash item changed. Refresh Trash and select it again.')
          if (row.availability === 'removed') {
            // This acknowledges all matching historical failed journals before
            // restoring the catalog row, preventing startup from hiding it again.
            this.selected.restoreRemoved(change)
          } else {
            const recovery = this.recovery(row, entries)
            if (
              !recovery ||
              !['trashed', 'restored', 'uncertain'].includes(recovery.status) ||
              !recovery.trashPath
            )
              throw Error(
                'No confirmed recoverable Trash location is saved. Check Finder Trash and the original path; no file was moved or overwritten.'
              )
            if (recovery.origin === 'selected')
              await this.selected.restore(recovery.batchId, [row.id])
            else {
              await this.duplicates.restore(recovery.batchId, [row.id])
              await this.duplicates.wait()
            }
          }
          const restored = this.db.get(change.id)
          if (!restored || ['trashed', 'removed'].includes(restored.availability)) {
            const details = this.recoveries().find(
              entry =>
                entry.id === change.id &&
                entry.path === row.path &&
                entry.batchId === this.recovery(row, entries)?.batchId
            )
            throw Error(
              details?.reason ||
                'This item could not be restored. Its existing files were left alone.'
            )
          }
          result.restored++
        } catch (error) {
          result.failed++
          result.errors.push({
            id: change.id,
            message: error instanceof Error ? error.message : 'This item could not be restored.',
          })
        }
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      return result
    } finally {
      this.busy = false
    }
  }
}

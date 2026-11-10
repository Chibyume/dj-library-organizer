import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { trackTrashFixture } from './track-trash'
import { TrackTrash } from '../src/track-trash'
import { TrashLibrary } from '../src/trash-library'
import { DuplicateCleanup } from '../src/duplicate-cleanup'
import type { DuplicateHashes, CatalogFile } from '../src/duplicate-hashes'
import type { Preparation } from '../src/preparation'
import type { LibraryQuery } from '../src/shared'

const query: LibraryQuery = {
  search: '',
  view: 'trash',
  sort: 'title',
  direction: 'asc',
  offset: 0,
  limit: 50,
}
function cleanupFor(f: Awaited<ReturnType<typeof trackTrashFixture>>) {
  const hashes = {
    running: false,
    hash: async (file: CatalogFile) =>
      createHash('sha256')
        .update(await readFile(file.path))
        .digest('hex'),
  } as unknown as DuplicateHashes
  const preparation = {
    running: false,
    reconcileCleanupChoices: async () => {},
  } as unknown as Preparation
  return new DuplicateCleanup(f.db, f.helper, hashes, preparation, () => {})
}

test('managed Trash browses and paginates all 411 historical duplicate records and restores only the selected ID', async () => {
  const f = await trackTrashFixture()
  try {
    const selected = new TrackTrash(f.db, f.helper, () => {}),
      duplicates = cleanupFor(f)
    const entries: any[] = []
    for (let index = 0; index < 411; index++) {
      const track = await f.add(`Historical ${String(index).padStart(3, '0')}.wav`),
        row = f.db.get(track.id) as CatalogFile
      const hash = createHash('sha256')
        .update(await readFile(track.path))
        .digest('hex')
      const moved =
        index < 2
          ? await f.helper.call<{ path: string }>('trash', {
              path: track.path,
              expected: await f.inspect(track.path),
            })
          : { path: path.join(f.trash, `historical-${index}.wav`) }
      f.db.db
        .prepare("UPDATE files SET availability='trashed',revision=revision+1 WHERE id=?")
        .run(track.id)
      f.db.db.prepare('UPDATE locations SET available=0 WHERE fileId=?').run(track.id)
      entries.push({
        file: row,
        keeper: row,
        hash,
        status: 'trashed',
        trashPath: moved.path,
      })
    }
    const id = randomUUID(),
      createdAt = new Date().toISOString()
    await writeFile(
      path.join(f.db.directory, 'duplicate-cleanup', id + '.json'),
      JSON.stringify({
        version: 1,
        decisions: [],
        backup: 'synthetic-backup.sqlite',
        createdAt,
        state: {
          id,
          status: 'completed',
          total: 411,
          trashed: 411,
          restored: 0,
          failed: 0,
          bytes: 0,
          current: '',
          error: null,
        },
        entries,
      })
    )
    const library = new TrashLibrary(f.db, f.helper, selected, duplicates)
    const first = library.list(query),
      second = library.list({ ...query, offset: 50 })
    assert.equal(first.total, 411)
    assert.equal(first.tracks.length, 50)
    assert.equal(second.tracks.length, 50)
    assert.equal(first.tracks[0]?.trash?.origin, 'duplicate')
    assert.equal(first.tracks[0]?.trash?.state, 'in-trash')
    assert.equal(first.tracks[0]?.trash?.batchId, id)
    assert.notEqual(first.tracks[0]?.id, second.tracks[0]?.id)
    const searched = library.list({ ...query, search: 'Historical 410' })
    assert.equal(searched.total, 1)
    const chosen = f.db.get(entries[0].file.id)!,
      other = f.db.get(entries[1].file.id)!
    const result = await library.restoreSelected([{ id: chosen.id, revision: chosen.revision }])
    assert.deepEqual(result, { restored: 1, failed: 0, errors: [] })
    assert.equal(f.restores, 1)
    assert.equal(f.db.get(chosen.id)?.availability, 'available')
    assert.equal(f.db.get(other.id)?.availability, 'trashed')
    assert.equal(library.list(query).total, 410)
    assert.equal(
      createHash('sha256')
        .update(await readFile(chosen.path))
        .digest('hex'),
      entries[0].hash
    )
    assert.equal(
      createHash('sha256')
        .update(await readFile(entries[1].trashPath))
        .digest('hex'),
      entries[1].hash
    )
  } finally {
    f.close()
  }
})

test('managed Trash shows physical moves while keeping catalog-only fallback hidden and internally recoverable', async () => {
  const f = await trackTrashFixture()
  try {
    const a = await f.add('native.wav'),
      b = await f.add('catalog-only.wav')
    f.deny(b.path)
    const selected = new TrackTrash(f.db, f.helper, () => {}),
      duplicates = cleanupFor(f),
      library = new TrashLibrary(f.db, f.helper, selected, duplicates)
    const batch = await selected.start(
      (await selected.preview([a, b].map(({ id, revision }) => ({ id, revision })))).token
    )
    const rows = library.list(query)
    assert.equal(rows.total, 1)
    assert.equal(
      rows.tracks.some(track => track.id === b.id),
      false
    )
    assert.equal(library.list({ ...query, search: 'catalog-only' }).total, 0)
    assert.equal(f.db.list({ ...query, view: 'all' }).total, 0)
    assert.equal(f.db.summary().files, 0)
    assert.equal(f.db.summary().trash, 1)
    const removed = f.db.get(b.id)!,
      trashed = rows.tracks.find(track => track.id === a.id)!
    assert.equal(removed.availability, 'removed')
    const marker = f.db.db
      .prepare('SELECT locationState,reason FROM library_removals WHERE fileId=?')
      .get(b.id) as { locationState: string; reason: string }
    assert.equal(marker.locationState, 'original-kept')
    assert.match(marker.reason, /permission/)
    assert.equal(trashed.trash?.state, 'in-trash')
    assert.equal(trashed.trash?.batchId, batch.id)
    const result = await library.restoreSelected([{ id: b.id, revision: removed.revision }])
    assert.equal(result.restored, 1)
    assert.equal(f.restores, 0)
    new TrackTrash(f.db, f.helper, () => {})
    assert.equal(f.db.get(b.id)?.availability, 'available')
    assert.equal(f.db.get(a.id)?.availability, 'trashed')
    assert.equal(library.list(query).total, 1)
  } finally {
    f.close()
  }
})

test('managed Trash retains rows without recovery journals and rejects stale selected revisions per item', async () => {
  const f = await trackTrashFixture()
  try {
    const missing = await f.add('legacy-no-journal.wav')
    f.db.db
      .prepare("UPDATE files SET availability='trashed',revision=revision+1 WHERE id=?")
      .run(missing.id)
    const selected = new TrackTrash(f.db, f.helper, () => {}),
      library = new TrashLibrary(f.db, f.helper, selected, cleanupFor(f))
    const listed = library.list(query)
    assert.equal(listed.total, 1)
    assert.equal(listed.tracks[0]?.trash?.origin, 'catalog')
    assert.match(listed.tracks[0]?.trash?.reason || '', /No validated recovery path/)
    const stale = await library.restoreSelected([{ id: missing.id, revision: 0 }])
    assert.equal(stale.failed, 1)
    assert.equal(f.restores, 0)
    const unknown = await library.restoreSelected([
      { id: missing.id, revision: f.db.get(missing.id)!.revision },
    ])
    assert.equal(unknown.failed, 1)
    assert.match(unknown.errors[0]?.message || '', /No confirmed recoverable/)
    assert.equal(f.db.get(missing.id)?.availability, 'trashed')
  } finally {
    f.close()
  }
})

test('historical duplicate restore repairs its catalog after a confirmed native restore inspection failure without moving twice', async () => {
  const f = await trackTrashFixture()
  try {
    const track = await f.add('historical-restore-gap.wav'),
      row = f.db.get(track.id) as CatalogFile
    const bytes = await readFile(track.path),
      hash = createHash('sha256').update(bytes).digest('hex')
    const moved = await f.helper.call<{ path: string }>('trash', {
      path: track.path,
      expected: await f.inspect(track.path),
    })
    f.db.db
      .prepare("UPDATE files SET availability='trashed',revision=revision+1 WHERE id=?")
      .run(track.id)
    const duplicates = cleanupFor(f),
      selected = new TrackTrash(f.db, f.helper, () => {}),
      library = new TrashLibrary(f.db, f.helper, selected, duplicates)
    const id = randomUUID()
    await writeFile(
      path.join(f.db.directory, 'duplicate-cleanup', id + '.json'),
      JSON.stringify({
        version: 1,
        decisions: [],
        backup: 'synthetic.sqlite',
        createdAt: new Date().toISOString(),
        state: {
          id,
          status: 'completed',
          total: 1,
          trashed: 1,
          restored: 0,
          failed: 0,
          bytes: row.size,
          current: '',
          error: null,
        },
        entries: [
          {
            file: row,
            keeper: row,
            hash,
            status: 'trashed',
            trashPath: moved.path,
          },
        ],
      })
    )
    f.failNextRestoredInspection()
    const first = await library.restoreSelected([
      { id: track.id, revision: f.db.get(track.id)!.revision },
    ])
    assert.equal(first.failed, 1)
    assert.equal(f.restores, 1)
    assert.equal(f.db.get(track.id)?.availability, 'trashed')
    assert.equal(library.list(query).tracks[0]?.trash?.state, 'unconfirmed')
    const retry = await library.restoreSelected([
      { id: track.id, revision: f.db.get(track.id)!.revision },
    ])
    assert.equal(retry.restored, 1)
    assert.equal(f.restores, 1)
    assert.equal(f.db.get(track.id)?.availability, 'available')
    assert.deepEqual(await readFile(track.path), bytes)
  } finally {
    f.close()
  }
})

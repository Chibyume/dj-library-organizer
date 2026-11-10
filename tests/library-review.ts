import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { LibraryDB } from '../src/db'
import { Preparation } from '../src/preparation'
import type { NativeHelper } from '../src/native'
import type { DuplicateHashes } from '../src/duplicate-hashes'
import type { LibraryQuery } from '../src/shared'

const ALL = { scope: 'all' as const, ids: [] }
const query: LibraryQuery = {
  view: 'review',
  search: '',
  sort: 'title',
  direction: 'asc',
  offset: 0,
  limit: 50,
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'organizer-review-synthetic-'))
  const db = new LibraryDB(path.join(root, 'profile'))
  const source = db.addSource(path.join(root, 'synthetic-audio'))
  // No native helper or audio exists in these tests: review must use saved evidence.
  const prep = new Preparation(
    db,
    {} as NativeHelper,
    { running: false, state: () => null } as unknown as DuplicateHashes,
    () => {}
  )
  function add(
    id: string,
    changes: Partial<{
      title: string
      artist: string
      category: string | null
      review: string
      availability: string
      hash: string | null
    }> = {}
  ) {
    const now = new Date().toISOString()
    db.db
      .prepare(
        `INSERT INTO files(id,physicalKey,path,filename,sourceId,signature,artist,title,genre,duration,size,category,review,availability,addedAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        'physical-' + id,
        path.join(source.path, id + '.wav'),
        id + '.wav',
        source.id,
        'signature-' + id,
        changes.artist ?? 'Synthetic Artist',
        changes.title ?? id,
        'Pop',
        180,
        100,
        changes.category === undefined ? 'Pop' : changes.category,
        changes.review ?? 'Ready for Approval',
        changes.availability ?? 'available',
        now,
        now
      )
    db.db
      .prepare('INSERT INTO classification_results VALUES(?,?,?,?,NULL)')
      .run(id, 'classification-' + id, '{}', now)
    db.db.prepare('DELETE FROM classification_queue WHERE fileId=?').run(id)
    if (changes.hash !== null)
      db.db
        .prepare('INSERT INTO file_hashes VALUES(?,?,?,?,NULL,?)')
        .run(id, 'signature-' + id, 'physical-' + id, changes.hash ?? 'hash-' + id, now)
  }
  async function close() {
    await prep.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
  return { root, db, prep, source, add, close }
}

test('Review held reasons and approval counts exactly match the full preparation preview', async () => {
  const f = await fixture()
  try {
    f.add('ready')
    f.add('workflow', { category: '_JUNK' })
    f.add('unavailable', { availability: 'missing' })
    f.add('excluded', { review: 'Excluded' })
    f.add('duplicate-a', { hash: 'same-bytes', title: 'Same Recording' })
    f.add('duplicate-b', { hash: 'same-bytes', title: 'Same Recording' })
    f.add('trashed', { availability: 'trashed' })
    const preview = await f.prep.preview(ALL)
    const overview = await f.prep.reviewOverview()
    assert.equal(overview.held, preview.blocked)
    assert.equal(overview.needsApproval, preview.needsApproval)
    assert.equal(overview.total, preview.blocked + preview.needsApproval)
    assert.deepEqual(overview.reasons, preview.reasons)
    const page = await f.prep.reviewList({ ...query, value: 'held' })
    assert.equal(page.total, preview.blocked)
    const held = f.prep.page(preview.token, 0, 'blocked')
    assert.deepEqual(
      new Map(page.tracks.map(track => [track.id, track.preparationReason])),
      new Map(held.items.map(item => [item.id, item.reason]))
    )
    // Reading Review never replaces or expires the user's active preview token.
    assert.equal(f.prep.page(preview.token, 0, 'all').total, preview.total)
    assert.equal(overview.reasons['No performance category'], 1)
    assert.equal(overview.reasons['Duplicate review needed'], 2)
    assert.equal(overview.reasons['File unavailable'], 1)
    const statuses = (await f.prep.reviewList({ ...query, sort: 'review' })).tracks.map(
      track => track.preparationReason || 'Ready to approve'
    )
    assert.deepEqual(statuses, [
      'Duplicate review needed',
      'Duplicate review needed',
      'Excluded by you',
      'File unavailable',
      'No performance category',
      'Ready to approve',
    ])
  } finally {
    await f.close()
  }
})

test('Review filters use exact reasons, escaped search, stable sorting and pagination', async () => {
  const f = await fixture()
  try {
    f.add('alpha', { category: '_JUNK', title: 'A 100% song' })
    f.add('beta', { category: '_MIXES', title: 'B 100 percent song' })
    f.add('ready', { title: 'C Ready' })
    f.db.db
      .prepare("INSERT INTO organization_tags VALUES('beta','use','Practice route','manual')")
      .run()
    assert.equal((await f.prep.reviewList(query)).total, 3)
    assert.equal((await f.prep.reviewList({ ...query, value: 'No performance category' })).total, 2)
    assert.deepEqual(
      (await f.prep.reviewList({ ...query, value: 'held', search: '%' })).tracks.map(t => t.id),
      ['alpha']
    )
    const second = await f.prep.reviewList({
      ...query,
      value: 'held',
      offset: 1,
      limit: 1,
    })
    assert.equal(second.total, 2)
    assert.equal(second.tracks[0]!.id, 'beta')
    assert.equal((await f.prep.reviewList({ ...query, value: 'approval' })).total, 1)
    assert.equal((await f.prep.reviewList({ ...query, value: 'Unknown reason' })).total, 0)
    const tagSearch = await f.prep.reviewList({
      ...query,
      search: 'Practice route',
    })
    assert.equal(tagSearch.total, 1)
    assert.equal(tagSearch.tracks[0]!.id, 'beta')
  } finally {
    await f.close()
  }
})

test('Review invalidates cached approvals and stale duplicate choices with changed evidence', async () => {
  const f = await fixture()
  try {
    f.add('ready')
    let preview = await f.prep.preview(ALL)
    await f.prep.reviewOverview()
    await f.prep.approve(preview.token)
    assert.equal((await f.prep.reviewOverview()).total, 0)
    f.db.db.prepare("UPDATE files SET revision=revision+1 WHERE id='ready'").run()
    assert.equal((await f.prep.reviewOverview()).needsApproval, 1)
    f.add('copy-a', { hash: 'copy-hash', title: 'Copies' })
    f.add('copy-b', { hash: 'copy-hash', title: 'Copies' })
    let group = (await f.prep.duplicates(0)).groups[0]!
    await f.prep.resolve(group.key, group.fingerprint, 'copy-a')
    assert.equal(
      (await f.prep.reviewOverview()).reasons['Alternate copy omitted from playlists'],
      1
    )
    f.db.db.prepare("UPDATE files SET signature='new-signature' WHERE id='copy-a'").run()
    f.db.db.prepare("DELETE FROM classification_queue WHERE fileId='copy-a'").run()
    f.db.db.prepare("UPDATE file_hashes SET signature='new-signature' WHERE fileId='copy-a'").run()
    const overview = await f.prep.reviewOverview()
    assert.equal(overview.reasons['Duplicate review needed'], 2)
    assert.equal(overview.reasons['Alternate copy omitted from playlists'], undefined)
    preview = await f.prep.preview(ALL)
    assert.deepEqual(overview.reasons, preview.reasons)
  } finally {
    await f.close()
  }
})

test('Review exposes Rekordbox identity conflicts even when the saved classifier status is ready', async () => {
  const f = await fixture()
  try {
    f.add('conflict')
    const now = new Date().toISOString()
    f.db.db
      .prepare(
        `INSERT INTO rb_snapshots(id,sourcePath,importedAt,modifiedAt,hash,size,product,tracks,playlists,memberships,dangling,warnings,matchedAt,active) VALUES('snapshot','/synthetic/reference.xml',?,?,'snapshot-hash',10,'Synthetic',1,0,0,0,'[]',?,1)`
      )
      .run(now, now, now)
    f.db.db
      .prepare("INSERT INTO rb_tracks VALUES('snapshot','1',?,?,'local','[]','[]')")
      .run(JSON.stringify({ Name: 'Different identity' }), f.db.get('conflict')!.path)
    f.db.db
      .prepare(
        "INSERT INTO rb_matches VALUES('snapshot','1','conflict','Identity differs','conflict','[]',?)"
      )
      .run(JSON.stringify(['Name: Different identity']))
    const overview = await f.prep.reviewOverview()
    const preview = await f.prep.preview(ALL)
    assert.equal(overview.reasons['Rekordbox reference conflict'], 1)
    assert.deepEqual(overview.reasons, preview.reasons)
    assert.equal(
      (await f.prep.reviewList({ ...query, value: 'held' })).tracks[0]!.review,
      'Ready for Approval'
    )
    assert.equal(
      (await f.prep.reviewList({ ...query, value: 'held' })).tracks[0]!.preparationReason,
      'Rekordbox reference conflict'
    )
  } finally {
    await f.close()
  }
})

test('Review detects external database changes and rebuilds evidence changed during a yielded read', async () => {
  const f = await fixture()
  const other = new Database(path.join(f.root, 'profile', 'library.sqlite'))
  try {
    f.add('changing')
    assert.equal((await f.prep.reviewOverview()).needsApproval, 1)
    other.prepare("UPDATE files SET availability='missing' WHERE id='changing'").run()
    assert.equal((await f.prep.reviewOverview()).reasons['File unavailable'], 1)
    other.prepare("UPDATE files SET availability='available' WHERE id='changing'").run()
    other.prepare("DELETE FROM classification_queue WHERE fileId='changing'").run()
    const duringRead = f.prep.reviewOverview()
    // Context deliberately yields after the saved catalog batch. This mutation
    // must invalidate that in-flight assessment as well as the previous cache.
    other.prepare("UPDATE files SET availability='missing' WHERE id='changing'").run()
    assert.equal((await duringRead).reasons['File unavailable'], 1)
    const preview = await f.prep.preview(ALL)
    assert.deepEqual((await f.prep.reviewOverview()).reasons, preview.reasons)
  } finally {
    other.close()
    await f.close()
  }
})

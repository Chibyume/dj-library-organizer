import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { LibraryDB } from '../src/db'
import { Preparation } from '../src/preparation'
import { verifyExport } from '../src/export-verification'
import type { ExportRecord } from '../src/preparation-types'
import type { NativeHelper } from '../src/native'
import type { DuplicateHashes } from '../src/duplicate-hashes'
import { requestSchemas } from '../src/shared'
function fixture(count = 3) {
  const root = path.resolve('../../work/verification-' + randomUUID())
  const db = new LibraryDB(path.join(root, 'profile'))
  const prep = new Preparation(
    db,
    {} as NativeHelper,
    { running: false } as DuplicateHashes,
    () => {}
  )
  const past = new Date(Date.now() - 60000).toISOString(),
    recent = new Date(Date.now() - 1000).toISOString()
  const record: ExportRecord = {
    id: randomUUID(),
    createdAt: past,
    completedAt: past,
    directory: path.join(root, 'batch'),
    namespace: 'Synthetic batch ' + randomUUID(),
    tracks: count,
    status: 'exported',
    error: null,
    reportedImportedAt: null,
  }
  const tracks = Array.from({ length: count }, (_, i) => ({
    path: path.join(root, `Synthetic ${i} Á #.wav`),
    category: i === 2 ? 'Dance' : 'Pop',
  }))
  const manifest = {
    version: 1,
    id: record.id,
    namespace: record.namespace,
    tracks,
    files: [{ name: 'rekordbox.xml', sha256: 'organizer-hash' }],
  }
  db.db
    .prepare('INSERT INTO playlist_exports VALUES(?,?,?)')
    .run(record.id, JSON.stringify(record), JSON.stringify(manifest))
  const snapshotId = randomUUID()
  db.db
    .prepare('INSERT INTO rb_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)')
    .run(
      snapshotId,
      path.join(root, 'fresh-rekordbox.xml'),
      recent,
      recent,
      'native-hash',
      100,
      'rekordbox 7.2.14',
      count,
      2,
      count,
      0,
      '[]',
      recent
    )
  const node = db.db.prepare('INSERT INTO rb_nodes VALUES(?,?,?,?,?,?,?,?,?)')
  node.run(snapshotId, 'root', null, 'ROOT', 'folder', null, 0, 0, 1)
  node.run(snapshotId, 'namespace', 'root', record.namespace, 'folder', null, 0, 1, 2)
  node.run(snapshotId, 'group', 'namespace', 'CLUB & PARTY', 'folder', null, 0, 2, 3)
  node.run(snapshotId, 'pop', 'group', 'Pop', 'playlist', '0', 0, 3, 4)
  node.run(snapshotId, 'dance', 'group', 'Dance', 'playlist', '0', 0, 3, 5)
  const track = db.db.prepare('INSERT INTO rb_tracks VALUES(?,?,?,?,?,?,?)')
  const member = db.db.prepare('INSERT INTO rb_memberships VALUES(?,?,?,?,?,?)')
  db.db.transaction(() =>
    tracks.forEach((t, i) => {
      const key = String(800000 + i) // Native snapshot IDs deliberately differ from organizer export IDs.
      track.run(snapshotId, key, '{}', t.path, 'local', '[]', '[]')
      member.run(snapshotId, t.category.toLowerCase(), i, key, '0', key)
    })
  )()
  return {
    root,
    db,
    prep,
    record,
    manifest,
    tracks,
    snapshotId,
    node,
    track,
    member,
    close: () => db.close(),
  }
}

test('fresh native XML verifies exact paths/hierarchy independently of track IDs and retains reported import', async () => {
  const f = fixture()
  try {
    f.prep.reportImported(f.record.id)
    const checked = await f.prep.verify(f.record.id)
    assert.equal(checked.verification?.status, 'matched')
    assert.equal(checked.verification?.matched, 3)
    assert.equal(checked.verification?.playlists.length, 2)
    assert.ok(checked.reportedImportedAt)
    assert.match(checked.verification!.message, /Playback.*cues and grids still need checking/)
    assert.equal(f.prep.history()[0]?.verification?.current, true)
    f.db.db.prepare('UPDATE rb_snapshots SET active=0').run()
    assert.equal(f.prep.history()[0]?.verification?.current, false)
    // A failed/cancelled refresh does not activate a snapshot and cannot produce a match.
    const noSnapshot = await f.prep.verify(f.record.id)
    assert.equal(noSnapshot.verification?.status, 'inconclusive')
    assert.equal(noSnapshot.verification?.snapshot, null)
  } finally {
    f.close()
  }
})

test('own exports, stale timestamps, unknown producers and future dates never establish a match', async () => {
  const f = fixture()
  try {
    const recent = new Date(Date.now() - 1000).toISOString()
    for (const values of [
      ['DJ Library Organizer 0.6.0', recent, 'different', path.join(f.root, 'fresh.xml')],
      ['rekordbox 7.2.14', recent, 'organizer-hash', path.join(f.root, 'fresh.xml')],
      ['rekordbox 7.2.14', recent, 'different', path.join(f.record.directory, 'rekordbox.xml')],
      ['rekordbox 7.2.14', f.record.createdAt, 'different', path.join(f.root, 'fresh.xml')],
      [
        'rekordbox 7.2.14',
        new Date(Date.now() + 86400000).toISOString(),
        'different',
        path.join(f.root, 'fresh.xml'),
      ],
      ['rekordbox impostor', 'invalid date', 'different', path.join(f.root, 'fresh.xml')],
      ['Unknown product', recent, 'different', path.join(f.root, 'fresh.xml')],
    ]) {
      f.db.db
        .prepare('UPDATE rb_snapshots SET product=?,modifiedAt=?,hash=?,sourcePath=?')
        .run(...values)
      assert.equal((await f.prep.verify(f.record.id)).verification?.status, 'inconclusive')
    }
  } finally {
    f.close()
  }
})

test('partial imports distinguish missing, extra and dangling entries and ignore unrelated native playlists', async () => {
  const f = fixture()
  try {
    f.db.db.prepare("DELETE FROM rb_memberships WHERE nodeId='pop' AND ordinal=1").run()
    f.track.run(f.snapshotId, 'extra', '{}', path.join(f.root, 'Extra.wav'), 'local', '[]', '[]')
    f.member.run(f.snapshotId, 'pop', 4, 'extra', '0', 'extra')
    f.member.run(f.snapshotId, 'pop', 5, 'missing-native-track', '0', null)
    f.node.run(f.snapshotId, 'unrelated', 'root', 'Other crate', 'playlist', '0', 1, 1, 6)
    f.member.run(f.snapshotId, 'unrelated', 0, 'extra', '0', 'extra')
    let result = (await f.prep.verify(f.record.id)).verification!
    const pop = result.playlists.find(p => p.category === 'Pop')!
    assert.equal(result.status, 'differences')
    assert.deepEqual([pop.matched, pop.missing, pop.extra, pop.unresolved], [1, 1, 1, 1])
    assert.equal(result.unexpectedPlaylists, 0)
    f.node.run(f.snapshotId, 'unexpected', 'namespace', 'Unplanned crate', 'playlist', '0', 0, 2, 7)
    result = (await f.prep.verify(f.record.id)).verification!
    assert.equal(result.unexpectedPlaylists, 1)
    assert.deepEqual(result.unexpectedExamples, ['Unplanned crate'])
    f.db.db.prepare("DELETE FROM rb_nodes WHERE id='dance'").run()
    assert.equal(
      (await f.prep.verify(f.record.id)).verification?.playlists.find(p => p.category === 'Dance')
        ?.status,
      'missing-playlist'
    )
  } finally {
    f.close()
  }
})

test('repeated collection paths, playlist memberships and duplicate folders stay ambiguous', async () => {
  const f = fixture()
  try {
    f.track.run(f.snapshotId, 'copy', '{}', f.tracks[0]!.path, 'local', '[]', '[]')
    f.member.run(f.snapshotId, 'pop', 6, '800001', '0', '800001')
    let result = (await f.prep.verify(f.record.id)).verification!
    const pop = result.playlists.find(p => p.category === 'Pop')!
    assert.deepEqual([pop.matched, pop.ambiguous, pop.duplicateEntries], [0, 2, 1])
    f.node.run(f.snapshotId, 'pop-copy', 'group', 'Pop', 'playlist', '0', 0, 3, 6)
    result = (await f.prep.verify(f.record.id)).verification!
    assert.equal(result.playlists.find(p => p.category === 'Pop')?.status, 'ambiguous-playlist')
    f.node.run(f.snapshotId, 'namespace-copy', 'root', f.record.namespace, 'folder', null, 0, 1, 7)
    result = (await f.prep.verify(f.record.id)).verification!
    assert.equal(result.status, 'inconclusive')
    assert.equal(result.matched, 0)
  } finally {
    f.close()
  }
})

test('verification uses exact case-sensitive normalized paths and exact expected hierarchy', async () => {
  const f = fixture()
  try {
    f.db.db
      .prepare("UPDATE rb_tracks SET localPath=? WHERE trackKey='800000'")
      .run(f.tracks[0]!.path.normalize('NFD'))
    assert.equal((await f.prep.verify(f.record.id)).verification?.status, 'matched')
    f.db.db
      .prepare("UPDATE rb_tracks SET localPath=? WHERE trackKey='800001'")
      .run(f.tracks[1]!.path.replace('Synthetic', 'synthetic'))
    let result = (await f.prep.verify(f.record.id)).verification!
    assert.equal(result.playlists.find(p => p.category === 'Pop')?.missing, 1)
    f.db.db.prepare("UPDATE rb_nodes SET parentId='root' WHERE id='pop'").run()
    result = (await f.prep.verify(f.record.id)).verification!
    assert.equal(result.playlists.find(p => p.category === 'Pop')?.status, 'missing-playlist')
    f.db.db.prepare("UPDATE rb_nodes SET name='Renamed batch' WHERE id='namespace'").run()
    result = (await f.prep.verify(f.record.id)).verification!
    assert.equal(result.status, 'differences')
    assert.match(result.message, /dated batch folder is absent/)
  } finally {
    f.close()
  }
})

test('cancelled and concurrently invalidated comparisons preserve the previous persisted result', async () => {
  const f = fixture(2000)
  try {
    const first = await f.prep.verify(f.record.id)
    const promise = f.prep.verify(f.record.id)
    f.prep.cancel()
    await assert.rejects(promise, /cancelled/)
    assert.deepEqual(f.prep.history()[0]?.verification, first.verification)
    const changed = verifyExport(f.db, f.record, JSON.stringify(f.manifest), () => {})
    f.db.db.prepare('UPDATE rb_snapshots SET active=0').run()
    await assert.rejects(changed, /snapshot changed/)
    assert.equal(f.prep.history()[0]?.verification?.current, false)
  } finally {
    f.close()
  }
})

test('verification rejects malformed manifests, unfinished exports and arbitrary paths at IPC', async () => {
  const f = fixture()
  try {
    for (const value of [
      { id: f.record.id, path: '/tmp/fake.xml' },
      '/tmp/fake.xml',
      { id: f.record.id, snapshot: 'forged' },
    ])
      assert.equal(requestSchemas.preparationVerify.safeParse(value).success, false)
    assert.equal(requestSchemas.preparationVerify.safeParse(f.record.id).success, true)
    await assert.rejects(f.prep.verify(randomUUID()), /not found/)
    f.db.db
      .prepare('UPDATE playlist_exports SET manifest=?')
      .run(JSON.stringify({ ...f.manifest, id: randomUUID() }))
    await assert.rejects(f.prep.verify(f.record.id), /disagree/)
    f.db.db.prepare("UPDATE playlist_exports SET data=json_set(data,'$.status','failed')").run()
    await assert.rejects(f.prep.verify(f.record.id), /not found/)
  } finally {
    f.close()
  }
})

test('50,000 exported paths compare with bounded UI evidence and regular service yields', async () => {
  const f = fixture(50000)
  try {
    f.db.db.prepare("DELETE FROM rb_memberships WHERE nodeId='pop' AND ordinal%2=0").run()
    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    const start = Date.now()
    let report
    try {
      report = (await f.prep.verify(f.record.id)).verification!
    } finally {
      clearInterval(timer)
    }
    assert.equal(report.expected, 50000)
    assert.equal(report.status, 'differences')
    assert.equal(report.playlists.find(p => p.category === 'Pop')?.missing, 24999)
    assert.ok(report.playlists.every(p => p.examples.length <= 5))
    assert.ok(JSON.stringify(report).length < 12000)
    assert.ok(ticks > 5)
    console.log(
      `Verification benchmark: ${JSON.stringify({ records: 50000, milliseconds: Date.now() - start, ticks, reportBytes: JSON.stringify(report).length })}`
    )
  } finally {
    f.close()
  }
})

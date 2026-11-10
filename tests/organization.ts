import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { LibraryDB } from '../src/db'
import { Organization } from '../src/organization'
import { Preparation } from '../src/preparation'
import type { NativeHelper } from '../src/native'
import type { DuplicateHashes } from '../src/duplicate-hashes'
import { inputDigest, researchInput } from '../src/research-identity'
import type { Category, LibraryQuery, Track } from '../src/shared'

const query: LibraryQuery = {
  search: '',
  view: 'all',
  sort: 'title',
  direction: 'asc',
  offset: 0,
  limit: 100,
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'dj-organization-synthetic-'))
  const profile = path.join(root, 'profile'),
    db = new LibraryDB(profile),
    organization = new Organization(db)
  const source = db.addSource(path.join(root, 'synthetic-audio'), true)
  const add = (options: Partial<Track> & { category?: Category | null } = {}) => {
    const id = randomUUID(),
      now = new Date().toISOString()
    db.register(
      {
        id,
        physicalKey: id,
        signature: `synthetic-${id}`,
        path: path.join(root, id + '.wav'),
        filename: 'Synthetic.wav',
        sourceId: source.id,
        artist: 'Synthetic Artist',
        title: 'Synthetic Song',
        bpm: 100,
        year: 2020,
        genre: null,
        duration: 180,
        format: 'WAV',
        bitrate: 1411,
        sampleRate: 44100,
        key: null,
        size: 128,
        availability: 'available',
        addedAt: now,
        updatedAt: now,
        metadataError: null,
        tags: {},
        ...options,
      },
      'synthetic-scan'
    )
    if (options.category !== undefined)
      db.db.prepare('UPDATE files SET category=? WHERE id=?').run(options.category, id)
    return id
  }
  const change = (id: string) => ({ id, revision: db.get(id)!.revision })
  const close = async () => {
    await organization.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  }
  return { root, profile, db, organization, source, add, change, close }
}

test('practice includes every available file independently of approval, categories and tool/version labels', async () => {
  const f = await fixture()
  try {
    const music = f.add({ genre: 'Hip-Hop/Rap', category: '_JUNK' })
    const unclassified = f.add({ title: 'Uncatalogued', genre: null })
    const tool = f.add({
      artist: 'Serato',
      title: '06 - Hip Hop Track',
      category: 'Hip Hop',
    })
    const mix = f.add({
      title: "A Nola Bounce Summer Mix '14",
      duration: 3709,
      category: 'Bounce',
    })
    const aCappella = f.add({
      title: 'Synthetic (A Cappella)',
      category: 'Hip Hop',
    })
    f.add({ availability: 'unavailable' })
    f.add({ availability: 'corrupt' })
    f.add({ availability: 'trashed' })
    f.db.db.prepare("UPDATE files SET review='Excluded' WHERE id=?").run(music)
    const before = f.db.db
      .prepare('SELECT id,path,category,review,manual FROM files ORDER BY id')
      .all()
    const result = await f.organization.organize()
    assert.equal(result.processed, 8)
    assert.equal(f.db.list({ ...query, view: 'practice' }).total, 5)
    assert.equal(f.organization.state().practiceCount, 5)
    assert.equal(f.organization.state().unsortedCount, 1)
    assert.deepEqual(
      f.db.list({ ...query, view: 'practice', value: 'unsorted' }).tracks.map(track => track.id),
      [unclassified]
    )
    assert.ok(
      f.organization
        .track(music)
        .tags.some(tag => tag.group === 'genre' && tag.value === 'Hip-Hop / Rap')
    )
    assert.ok(
      f.organization
        .track(tool)
        .tags.some(tag => tag.group === 'use' && tag.value === 'Tools & Samples')
    )
    assert.ok(
      f.organization.track(mix).tags.some(tag => tag.group === 'use' && tag.value === 'Full Mix')
    )
    assert.ok(
      f.organization
        .track(aCappella)
        .tags.some(tag => tag.group === 'version' && tag.value === 'A Cappella')
    )
    assert.deepEqual(
      f.db.db.prepare('SELECT id,path,category,review,manual FROM files ORDER BY id').all(),
      before
    )
    assert.equal(f.db.list({ ...query, search: 'Tools & Samples' }).total, 1)
    assert.equal(f.db.list({ ...query, view: 'tag', value: 'use:Full Mix' }).total, 1)
    assert.deepEqual(await f.organization.organize(), {
      processed: 0,
      changed: 0,
      pending: 0,
    })
  } finally {
    await f.close()
  }
})

test('explicit remix style corrects smart genre placement, preserves distinct styles and does not invent crowd roles', async () => {
  const f = await fixture()
  try {
    const salsa = f.add({
      title: 'LALA (Salsa Version)',
      genre: 'Reggaeton',
      category: 'Merengue',
    })
    const jersey = f.add({
      title: 'All Mine (Jersey Club Remix)',
      genre: 'R&B',
      category: 'R&B',
    })
    const afro = f.add({ genre: 'Afrobeats', category: 'Dance' })
    const dancehall = f.add({ genre: 'Dancehall', category: 'Dance' })
    const old = f.add({ category: 'Reggaeton Old' })
    const recent = f.add({ category: 'Reggaeton New' })
    await f.organization.organize()
    const genres = (id: string) =>
      f.organization
        .track(id)
        .tags.filter(tag => tag.group === 'genre')
        .map(tag => tag.value)
    assert.deepEqual(genres(salsa), ['Salsa'])
    assert.deepEqual(genres(jersey), ['Jersey Club'])
    assert.deepEqual(genres(afro), ['Afrobeats'])
    assert.deepEqual(genres(dancehall), ['Dancehall'])
    assert.deepEqual(genres(old), ['Reggaeton'])
    assert.deepEqual(genres(recent), ['Reggaeton'])
    assert.equal(f.db.list({ ...query, view: 'practice', value: 'Reggaeton' }).total, 2)
    assert.equal(
      f.organization.state().tags.some(tag => /peak|warm|familiar|closing/i.test(tag.value)),
      false
    )
  } finally {
    await f.close()
  }
})

test('automatic and non-genre organization preserve prepared approvals while explicit genre changes invalidate them', async () => {
  const f = await fixture()
  const prep = new Preparation(
    f.db,
    {} as NativeHelper,
    { running: false, state: () => null } as unknown as DuplicateHashes,
    () => {}
  )
  try {
    const id = f.add({
      genre: 'Pop',
      category: 'Pop',
      path: path.join(f.source.path, 'approved-synthetic.wav'),
    })
    const initial = f.db.get(id)! as Track & {
      signature: string
      physicalKey: string
    }
    f.db.db.prepare("UPDATE files SET review='Ready for Approval' WHERE id=?").run(id)
    f.db.db
      .prepare('INSERT INTO classification_results VALUES(?,?,?,?,NULL)')
      .run(id, 'synthetic-stable-classification', '{}', new Date().toISOString())
    f.db.db.prepare('DELETE FROM classification_queue WHERE fileId=?').run(id)
    f.db.db
      .prepare('INSERT INTO file_hashes VALUES(?,?,?,?,NULL,?)')
      .run(
        id,
        initial.signature,
        initial.physicalKey,
        'synthetic-stable-byte-hash',
        new Date().toISOString()
      )
    const all = { scope: 'all' as const, ids: [] }
    const before = await prep.preview(all)
    assert.equal(before.eligible, 1)
    await prep.approve(before.token)
    const approved = await prep.preview(all)
    assert.equal(approved.approved, 1)
    const revision = f.db.get(id)!.revision
    const storedApproval = f.db.db
      .prepare('SELECT fingerprint FROM playlist_approvals WHERE fileId=?')
      .get(id)
    await f.organization.organize()
    assert.equal(f.db.get(id)!.revision, revision)
    for (const [group, value] of [
      ['use', 'Warm-up'],
      ['version', 'My edit note'],
    ] as const)
      f.organization.tagsUpdate({
        changes: [f.change(id)],
        group,
        value,
        action: 'add',
      })
    f.organization.familiarity({ changes: [f.change(id)], value: 'known' })
    assert.equal(f.db.get(id)!.revision, revision)
    assert.equal((await prep.preview(all)).approved, 1)
    assert.deepEqual(
      f.db.db.prepare('SELECT fingerprint FROM playlist_approvals WHERE fileId=?').get(id),
      storedApproval
    )
    f.organization.tagsUpdate({
      changes: [f.change(id)],
      group: 'genre',
      value: 'Dembow',
      action: 'add',
    })
    assert.equal(f.db.get(id)!.revision, revision + 1)
    assert.equal(f.db.get(id)!.category, 'Dembow')
    // Simulate the classifier acknowledging the category evidence: approval must
    // still be renewed because the actual prepared genre changed.
    f.db.db.prepare('DELETE FROM classification_queue WHERE fileId=?').run(id)
    const changed = await prep.preview(all)
    assert.equal(changed.eligible, 1)
    assert.equal(changed.approved, 0)
    assert.equal(changed.needsApproval, 1)
    assert.throws(
      () =>
        f.organization.tagsUpdate({
          changes: [{ id, revision }],
          group: 'use',
          value: 'Stale selection',
          action: 'add',
        }),
      /selection changed/
    )
  } finally {
    await prep.close()
    await f.close()
  }
})

test('generic Latin metadata retains a specific saved Latin placement while stronger style evidence wins', async () => {
  const f = await fixture()
  try {
    const placements = [
      'Bachata',
      'Dembow',
      'Reggaeton Old',
      'Reggaeton New',
      'Merengue',
      'Latin R&B',
      'Salsa',
      'Cumbia',
      'Plena',
    ] as const
    const files = placements.map(category => ({
      id: f.add({ genre: 'Latin', category }),
      expected: category.startsWith('Reggaeton') ? 'Reggaeton' : category,
    }))
    const explicit = f.add({
      genre: 'Latin',
      category: 'Merengue',
      title: 'Synthetic (Salsa Version)',
    })
    const specificMetadata = f.add({ genre: 'Afrobeats', category: 'Dance' })
    const broad = f.add({ genre: 'Latin', category: 'Latin Other' })
    const conflictingStyle = f.add({ genre: 'Pop', category: 'Bachata' })
    await f.organization.organize()
    const values = (id: string) =>
      f.organization
        .track(id)
        .tags.filter(tag => tag.group === 'genre')
        .map(tag => tag.value)
    for (const file of files) assert.deepEqual(values(file.id), [file.expected])
    assert.deepEqual(values(explicit), ['Salsa'])
    assert.deepEqual(values(specificMetadata), ['Afrobeats'])
    assert.deepEqual(values(broad), ['Latin Other'])
    assert.deepEqual(values(conflictingStyle), ['Pop'])
  } finally {
    await f.close()
  }
})

test('legacy manual categories migrate once as authoritative genre tags while explicit version evidence stays visible', async () => {
  const f = await fixture()
  try {
    const manual = f.add({ genre: 'Pop' })
    const old = f.add({ genre: 'House' })
    const salsaVersion = f.add({
      title: 'LALA (Salsa Version)',
      genre: 'Reggaeton',
    })
    f.db.updateDecision([f.change(manual)], 'category', 'Dembow')
    f.db.updateDecision([f.change(old)], 'category', 'Reggaeton Old')
    f.db.updateDecision([f.change(salsaVersion)], 'category', 'Merengue')
    await f.organization.organize()
    const genreTags = (id: string) =>
      f.organization.track(id).tags.filter(tag => tag.group === 'genre')
    assert.deepEqual(genreTags(manual), [{ group: 'genre', value: 'Dembow', origin: 'manual' }])
    assert.deepEqual(genreTags(old), [{ group: 'genre', value: 'Reggaeton', origin: 'manual' }])
    assert.deepEqual(genreTags(salsaVersion), [
      { group: 'genre', value: 'Merengue', origin: 'manual' },
    ])
    assert.ok(
      f.organization
        .track(salsaVersion)
        .tags.some(tag => tag.group === 'version' && tag.value === 'Salsa version')
    )
    f.db.db.prepare("UPDATE files SET genre='Afrobeats' WHERE id=?").run(manual)
    await f.organization.organize()
    assert.deepEqual(genreTags(manual), [{ group: 'genre', value: 'Dembow', origin: 'manual' }])
    f.organization.tagsUpdate({
      changes: [f.change(manual)],
      group: 'genre',
      value: 'Salsa',
      action: 'add',
    })
    await f.organization.organize()
    assert.deepEqual(
      genreTags(manual).map(tag => tag.value),
      ['Dembow', 'Salsa']
    )
    assert.equal(f.db.get(manual)!.category, 'Salsa')
    for (const value of ['Dembow', 'Salsa'])
      f.organization.tagsUpdate({
        changes: [f.change(manual)],
        group: 'genre',
        value,
        action: 'remove',
      })
    await f.organization.organize()
    assert.deepEqual(genreTags(manual), [])
    assert.equal(f.db.get(manual)!.category, null)
    assert.equal(f.db.list({ ...query, view: 'practice' }).total, 3)
  } finally {
    await f.close()
  }
})

test('manual tags survive automatic passes and explicit removals, with atomic stale selection protection', async () => {
  const f = await fixture()
  try {
    const first = f.add({ genre: 'Pop' }),
      second = f.add({ genre: 'Pop' })
    await f.organization.organize()
    f.organization.tagsUpdate({
      changes: [f.change(first)],
      group: 'genre',
      value: 'Pop',
      action: 'remove',
    })
    f.organization.tagsUpdate({
      changes: [f.change(first)],
      group: 'genre',
      value: 'Salsa',
      action: 'add',
    })
    assert.equal(f.db.get(first)!.category, 'Salsa')
    assert.equal(f.db.get(first)!.manual, true)
    assert.equal(f.db.get(first)!.review, 'Ready for Approval')
    f.organization.tagsUpdate({
      changes: [f.change(first)],
      group: 'use',
      value: 'My transitions',
      action: 'add',
    })
    f.organization.familiarity({ changes: [f.change(first)], value: 'known' })
    f.db.db
      .prepare("UPDATE files SET genre='Pop / Dancehall',filename='Synthetic New.wav' WHERE id=?")
      .run(first)
    await f.organization.organize()
    const tags = f.organization.track(first).tags
    assert.ok(tags.some(tag => tag.value === 'Salsa' && tag.origin === 'manual'))
    assert.ok(tags.some(tag => tag.value === 'Dancehall' && tag.origin === 'automatic'))
    assert.ok(tags.some(tag => tag.value === 'My transitions' && tag.origin === 'manual'))
    assert.equal(
      tags.some(tag => tag.value === 'Pop'),
      false
    )
    assert.equal(f.organization.track(first).familiarity, 'known')
    assert.equal(tags.filter(tag => tag.group === 'familiarity').length, 1)
    const before = f.organization.track(first).tags
    assert.throws(
      () =>
        f.organization.tagsUpdate({
          changes: [f.change(first), { id: second, revision: -1 }],
          group: 'use',
          value: 'Must roll back',
          action: 'add',
        }),
      /selection changed/
    )
    assert.deepEqual(f.organization.track(first).tags, before)
    f.organization.tagsUpdate({
      changes: [f.change(first)],
      group: 'genre',
      value: 'Salsa',
      action: 'remove',
    })
    assert.equal(f.db.get(first)!.category, 'Dancehall')
    f.organization.tagsUpdate({
      changes: [f.change(first)],
      group: 'genre',
      value: 'Dancehall',
      action: 'remove',
    })
    assert.equal(f.db.get(first)!.category, null)
    assert.equal(f.db.get(first)!.review, 'Needs Manual Classification')
    assert.throws(
      () =>
        f.organization.tagsUpdate({
          changes: [f.change(first)],
          group: 'use',
          value: 'bad\nvalue',
          action: 'add',
        }),
      /control/
    )
  } finally {
    await f.close()
  }
})

test('custom folders and playlists share file membership and survive reopen without touching synthetic audio', async () => {
  const f = await fixture()
  try {
    const one = f.add({ genre: 'Pop' }),
      two = f.add({ genre: 'Reggaeton' })
    const audioPath = f.db.get(one)!.path
    const bytes = Buffer.from('synthetic fixture bytes only\n')
    await writeFile(audioPath, bytes)
    const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex')
    const before = sha(await readFile(audioPath))
    const folder = f.organization.playlistCreate({
      name: 'Thursday',
      kind: 'folder',
    })
    const first = f.organization.playlistCreate({
      name: 'Practice',
      parentId: folder.id,
      kind: 'playlist',
    })
    const second = f.organization.playlistCreate({
      name: 'Latin block',
      parentId: folder.id,
      kind: 'playlist',
    })
    f.organization.playlistMembers({
      id: first.id,
      ids: [one, two],
      action: 'add',
    })
    f.organization.playlistMembers({
      id: second.id,
      ids: [two],
      action: 'add',
    })
    f.organization.playlistMembers({
      id: second.id,
      ids: [two],
      action: 'add',
    })
    assert.equal(
      f.organization.state().playlists.find(playlist => playlist.id === folder.id)!.count,
      2
    )
    assert.equal(
      f.organization.state().playlists.find(playlist => playlist.id === second.id)!.count,
      1
    )
    assert.equal(f.db.list({ ...query, view: 'playlist', value: folder.id }).total, 2)
    assert.equal(f.organization.track(two).playlists.length, 2)
    assert.throws(
      () =>
        f.organization.playlistCreate({
          name: 'practice',
          parentId: folder.id,
          kind: 'playlist',
        }),
      /already exists/
    )
    assert.throws(
      () =>
        f.organization.playlistCreate({
          name: 'Invalid child',
          parentId: first.id,
          kind: 'playlist',
        }),
      /inside folders/
    )
    f.organization.playlistRename({ id: first.id, name: 'Core 30' })
    await f.organization.organize()
    const reopened = new LibraryDB(f.profile)
    try {
      const organization = new Organization(reopened)
      assert.equal(
        organization.state().playlists.find(playlist => playlist.id === first.id)!.name,
        'Core 30'
      )
      assert.equal(reopened.list({ ...query, view: 'playlist', value: second.id }).total, 1)
      await organization.close()
    } finally {
      reopened.close()
    }
    f.organization.playlistMembers({
      id: first.id,
      ids: [one],
      action: 'remove',
    })
    assert.equal(f.db.list({ ...query, view: 'playlist', value: first.id }).total, 1)
    f.organization.playlistDelete(folder.id)
    assert.equal(f.organization.state().playlists.length, 0)
    assert.equal(f.db.list({ ...query, view: 'practice' }).total, 2)
    assert.equal(sha(await readFile(audioPath)), before)
    assert.equal(f.db.get(one)!.path, audioPath)
  } finally {
    await f.close()
  }
})

test('only active exact-file Rekordbox evidence contributes smart genres and new evidence queues another pass', async () => {
  const f = await fixture()
  try {
    const exact = f.add({ title: 'Synthetic exact' })
    const conflict = f.add({ title: 'Synthetic conflicting' })
    await f.organization.organize()
    assert.equal(f.organization.state().unsortedCount, 2)
    const snapshotId = randomUUID(),
      now = new Date().toISOString()
    f.db.db
      .prepare(
        'INSERT INTO rb_snapshots(id,sourcePath,importedAt,modifiedAt,hash,size,product,tracks,playlists,memberships,dangling,warnings,matchedAt,active) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)'
      )
      .run(
        snapshotId,
        'synthetic.xml',
        now,
        now,
        'synthetic-hash',
        1,
        'synthetic',
        2,
        1,
        1,
        0,
        '[]',
        now
      )
    f.db.db
      .prepare('INSERT INTO rb_nodes VALUES(?,?,?,?,?,?,?,?,?)')
      .run(snapshotId, 'genre-playlist', null, '04 Dembow', 'playlist', '0', 1, 0, 0)
    for (const [index, id] of [exact, conflict].entries()) {
      const key = String(index + 1)
      f.db.db
        .prepare('INSERT INTO rb_tracks VALUES(?,?,?,?,?,?,?)')
        .run(
          snapshotId,
          key,
          JSON.stringify({ Name: 'Synthetic', Genre: index ? 'Salsa' : '' }),
          'synthetic.wav',
          'local',
          '[]',
          '[]'
        )
      f.db.db
        .prepare('INSERT INTO rb_matches VALUES(?,?,?,?,?,?,?)')
        .run(
          snapshotId,
          key,
          'referenced',
          'Synthetic exact-file fixture',
          id,
          '[]',
          JSON.stringify(index ? ['Name: identity mismatch'] : [])
        )
    }
    f.db.db
      .prepare('INSERT INTO rb_memberships VALUES(?,?,?,?,?,?)')
      .run(snapshotId, 'genre-playlist', 0, '1', '0', '1')
    f.db.db
      .prepare('UPDATE rb_snapshots SET matchedAt=? WHERE id=?')
      .run(now + 'updated', snapshotId)
    assert.equal(f.organization.state().pending, 2)
    await f.organization.organize()
    assert.ok(
      f.organization.track(exact).tags.some(tag => tag.group === 'genre' && tag.value === 'Dembow')
    )
    assert.equal(
      f.organization.track(conflict).tags.some(tag => tag.group === 'genre'),
      false
    )
    f.db.db.prepare('UPDATE rb_snapshots SET active=0 WHERE id=?').run(snapshotId)
    await f.organization.organize()
    assert.equal(
      f.organization.track(exact).tags.some(tag => tag.group === 'genre'),
      false
    )
    const newcomer = f.add({ genre: 'Rock' })
    assert.equal(f.organization.state().pending, 1)
    await f.organization.organize()
    assert.ok(f.organization.track(newcomer).tags.some(tag => tag.value === 'Rock'))
  } finally {
    await f.close()
  }
})

test('current approved research overrides broad metadata and saved placement while stale identity cannot keep supplying a genre', async () => {
  const f = await fixture()
  try {
    const id = f.add({ genre: 'Latin', category: 'Merengue' })
    await f.organization.organize()
    const file = f.db.get(id)!
    const signature = (file as Track & { signature: string }).signature
    f.db.db
      .prepare(
        'INSERT INTO research_approved(fileId,signature,inputHash,value,approvedAt) VALUES(?,?,?,?,?)'
      )
      .run(
        id,
        signature,
        inputDigest(researchInput(file)),
        JSON.stringify({ candidate: { genre: 'Salsa' } }),
        new Date().toISOString()
      )
    assert.equal(f.organization.state().pending, 1)
    await f.organization.organize()
    assert.deepEqual(
      f.organization
        .track(id)
        .tags.filter(tag => tag.group === 'genre')
        .map(tag => tag.value),
      ['Salsa']
    )
    f.db.db.prepare("UPDATE files SET artist='Different synthetic artist' WHERE id=?").run(id)
    assert.equal(f.organization.state().pending, 1)
    await f.organization.organize()
    assert.deepEqual(
      f.organization
        .track(id)
        .tags.filter(tag => tag.group === 'genre')
        .map(tag => tag.value),
      ['Merengue']
    )
    f.db.db.prepare('DELETE FROM research_approved WHERE fileId=?').run(id)
    assert.equal(f.organization.state().pending, 1)
    await f.organization.organize()
    assert.equal(f.organization.state().pending, 0)
  } finally {
    await f.close()
  }
})

test('schema 6 upgrades with backup, preserves catalogue decisions, and queues all existing files', async () => {
  const f = await fixture()
  let replacement: LibraryDB | undefined
  try {
    const id = f.add({ genre: 'Pop', category: 'Pop' })
    f.db.updateDecision([f.change(id)], 'category', 'Dembow')
    await f.organization.close()
    f.db.db.exec(
      'DROP TRIGGER organization_insert;DROP TRIGGER organization_evidence;DROP TRIGGER organization_snapshot;DROP TABLE organization_queue;DROP TABLE library_playlist_members;DROP TABLE library_playlists;DROP TABLE organization_overrides;DROP TABLE organization_tags;PRAGMA user_version=6;'
    )
    f.db.close()
    replacement = new LibraryDB(f.profile)
    assert.equal(replacement.db.pragma('user_version', { simple: true }), 8)
    const organization = new Organization(replacement)
    assert.equal(organization.state().pending, 1)
    assert.equal(replacement.get(id)!.manual, true)
    assert.equal(replacement.get(id)!.category, 'Dembow')
    await organization.organize()
    assert.equal(replacement.get(id)!.category, 'Dembow')
    const backupFile = (await readdir(f.profile)).find(name => name.startsWith('before-schema-7-'))!
    assert.ok(backupFile)
    const backup = new Database(path.join(f.profile, backupFile), {
      readonly: true,
    })
    try {
      assert.equal(backup.pragma('user_version', { simple: true }), 6)
    } finally {
      backup.close()
    }
    await organization.close()
  } finally {
    replacement?.close()
    if (f.db.db.open) f.db.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

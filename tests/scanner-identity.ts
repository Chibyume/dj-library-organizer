import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LibraryDB } from '../src/db'
import { stablePhysicalKey } from '../src/file-identity'
import { NativeHelper } from '../src/native'
import { Organization } from '../src/organization'
import { Scanner, physicalKey, signature } from '../src/scanner'
import type { LibraryQuery } from '../src/shared'
// @ts-expect-error Synthetic fixture generator is deliberately plain JavaScript.
import { wav } from '../scripts/fixtures.mjs'

const query: LibraryQuery = {
  view: 'all',
  search: '',
  sort: 'title',
  direction: 'asc',
  offset: 0,
  limit: 100,
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dj-scanner-identity-synthetic-')))
  const audio = path.join(root, 'audio'),
    profile = path.join(root, 'profile')
  await mkdir(audio)
  const db = new LibraryDB(profile),
    source = db.addSource(audio),
    helper = new NativeHelper(path.resolve('dist/native/organizer-helper')),
    organization = new Organization(db),
    scanner = new Scanner(db, helper, path.resolve('dist/metadata-worker.cjs'), () => {})
  const scan = async () => {
    scanner.start('smart')
    await scanner.wait()
    assert.equal(scanner.progress?.status, 'completed', JSON.stringify(scanner.progress))
  }
  const add = async (filename = 'tone.wav') => {
    const file = path.join(audio, filename)
    await writeFile(file, wav({ title: 'Synthetic identity', artist: 'Fixture', genre: 'Pop' }))
    await scan()
    const track = db.list(query).tracks.find(entry => entry.path === file)!
    assert.ok(track)
    return track
  }
  const oldDevice = (key: string) => {
    const parts = key.split('|')
    assert.equal(parts.length, 4)
    assert.match(parts[0]!, /^[a-f0-9-]{36}$/i)
    parts[1] = String(Number(parts[1]) + 4096)
    return parts.join('|')
  }
  return {
    root,
    audio,
    profile,
    db,
    source,
    helper,
    organization,
    scanner,
    scan,
    add,
    oldDevice,
    close: async () => {
      await scanner.wait()
      await organization.close()
      helper.close()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function legacyAlias(f: Awaited<ReturnType<typeof fixture>>, originalId: string) {
  const original = f.db.get(originalId)!,
    currentKey = physicalKey(await f.helper.inspect(original.path)),
    aliasId = randomUUID()
  f.db.db
    .prepare('UPDATE files SET physicalKey=?,addedAt=? WHERE id=?')
    .run(f.oldDevice(currentKey), '2020-01-01T00:00:00.000Z', originalId)
  const saved = f.db.db.prepare('SELECT * FROM files WHERE id=?').get(originalId) as Record<
    string,
    unknown
  >
  const columns = Object.keys(saved)
  f.db.db
    .prepare(`INSERT INTO files(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
    .run(
      ...columns.map(column =>
        column === 'id'
          ? aliasId
          : column === 'physicalKey'
            ? currentKey
            : column === 'addedAt'
              ? '2021-01-01T00:00:00.000Z'
              : saved[column]
      )
    )
  // A legacy observation can own the current path while the older row remains.
  f.db.db.prepare('UPDATE locations SET fileId=? WHERE fileId=?').run(aliasId, originalId)
  return { aliasId, currentKey }
}

test('stable volume identity ignores only device churn and retains distinct physical files', () => {
  const volume = '12345678-1234-1234-1234-123456789abc'
  assert.equal(
    stablePhysicalKey(`${volume}|10|20|30:40`),
    stablePhysicalKey(`${volume.toUpperCase()}|11|20|30:40`)
  )
  assert.notEqual(
    stablePhysicalKey(`${volume}|10|20|30:40`),
    stablePhysicalKey(`${volume}|11|21|30:40`)
  )
  assert.notEqual(
    stablePhysicalKey(`${volume}|10|20|30:40`),
    stablePhysicalKey(`${volume}|11|20|31:40`)
  )
  assert.notEqual(stablePhysicalKey('10|10|20|30:40'), stablePhysicalKey('11|11|20|30:40'))
})

test('same-path device churn retains the original file ID, manual tags and practice membership', async () => {
  const f = await fixture()
  try {
    const track = await f.add(),
      bytes = await readFile(track.path),
      info = await f.helper.inspect(track.path),
      currentKey = physicalKey(info)
    f.db.updateDecision([{ id: track.id, revision: track.revision }], 'category', 'Dembow')
    f.organization.tagsUpdate({
      changes: [{ id: track.id, revision: f.db.get(track.id)!.revision }],
      group: 'use',
      value: 'Pregame',
      action: 'add',
    })
    const playlist = f.organization.playlistCreate({
      name: 'Synthetic pregame',
      kind: 'playlist',
    })
    f.organization.playlistMembers({
      id: playlist.id,
      ids: [track.id],
      action: 'add',
    })
    f.db.db
      .prepare('UPDATE files SET physicalKey=? WHERE id=?')
      .run(f.oldDevice(currentKey), track.id)
    await f.scan()
    assert.equal(f.db.list(query).total, 1)
    assert.equal(f.db.get(track.id)!.availability, 'available')
    assert.equal(f.db.get(track.id)!.category, 'Dembow')
    assert.equal(f.db.get(track.id)!.manual, true)
    assert.ok(
      f.organization
        .track(track.id)
        .tags.some(tag => tag.value === 'Pregame' && tag.origin === 'manual')
    )
    assert.equal(f.organization.track(track.id).playlists[0]!.id, playlist.id)
    assert.equal(f.db.findPhysical(currentKey)!.id, track.id)
    assert.equal(f.scanner.progress!.newFiles, 0)
    assert.deepEqual(await readFile(track.path), bytes)
  } finally {
    await f.close()
  }
})

test('legacy same-path device aliases merge into the original record with decisions and both playlists retained', async () => {
  const f = await fixture()
  try {
    const original = await f.add(),
      currentKey = physicalKey(await f.helper.inspect(original.path)),
      aliasId = randomUUID()
    f.db.db
      .prepare('UPDATE files SET physicalKey=?,addedAt=? WHERE id=?')
      .run(f.oldDevice(currentKey), '2020-01-01T00:00:00.000Z', original.id)
    f.db.updateDecision([{ id: original.id, revision: original.revision }], 'category', 'Dembow')
    const saved = f.db.db.prepare('SELECT * FROM files WHERE id=?').get(original.id) as Record<
      string,
      unknown
    >
    const columns = Object.keys(saved)
    f.db.db
      .prepare(
        `INSERT INTO files(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`
      )
      .run(
        ...columns.map(column =>
          column === 'id'
            ? aliasId
            : column === 'physicalKey'
              ? currentKey
              : column === 'addedAt'
                ? '2021-01-01T00:00:00.000Z'
                : saved[column]
        )
      )
    f.db.observe(aliasId, f.source.id, original.path, 'legacy-alias')
    for (const [index, fileId] of [original.id, aliasId].entries()) {
      const playlist = f.organization.playlistCreate({
        name: `Synthetic list ${index}`,
        kind: 'playlist',
      })
      f.organization.playlistMembers({
        id: playlist.id,
        ids: [fileId],
        action: 'add',
      })
      f.organization.tagsUpdate({
        changes: [{ id: fileId, revision: f.db.get(fileId)!.revision }],
        group: 'use',
        value: `Synthetic use ${index}`,
        action: 'add',
      })
    }
    f.db.db
      .prepare('INSERT INTO playlist_approvals VALUES(?,?,?)')
      .run(aliasId, 'stale alias approval', new Date().toISOString())
    f.db.db
      .prepare('INSERT INTO duplicate_decisions VALUES(?,?,?,?)')
      .run('synthetic-group', 'stale fingerprint', aliasId, new Date().toISOString())
    const digest = createHash('sha256')
      .update(await readFile(original.path))
      .digest('hex')
    f.db.db
      .prepare('INSERT INTO file_hashes VALUES(?,?,?,?,?,?)')
      .run(
        original.id,
        saved.signature,
        f.oldDevice(currentKey),
        null,
        'File changed. Run Smart Scan.',
        new Date().toISOString()
      )
    f.db.db
      .prepare('INSERT INTO file_hashes VALUES(?,?,?,?,?,?)')
      .run(aliasId, saved.signature, currentKey, digest, null, new Date().toISOString())
    await f.scan()
    assert.equal(f.db.list(query).total, 1)
    assert.equal(f.db.get(aliasId), undefined)
    assert.equal(f.db.findPhysical(currentKey)!.id, original.id)
    assert.equal(f.db.get(original.id)!.manual, true)
    assert.equal(f.organization.track(original.id).playlists.length, 2)
    assert.equal(
      f.organization
        .track(original.id)
        .tags.filter(tag => tag.value.startsWith('Synthetic use ') && tag.origin === 'manual')
        .length,
      2
    )
    assert.equal(
      (
        f.db.db.prepare('SELECT COUNT(*) n FROM decisions WHERE fileId=?').get(original.id) as {
          n: number
        }
      ).n,
      1
    )
    assert.equal(
      (
        f.db.db
          .prepare("SELECT keeper FROM duplicate_decisions WHERE groupKey='synthetic-group'")
          .get() as { keeper: string }
      ).keeper,
      original.id
    )
    assert.equal(
      (
        f.db.db.prepare('SELECT COUNT(*) n FROM playlist_approvals').get() as {
          n: number
        }
      ).n,
      0
    )
    assert.deepEqual(
      f.db.db
        .prepare('SELECT physicalKey,hash,error FROM file_hashes WHERE fileId=?')
        .get(original.id),
      { physicalKey: currentKey, hash: digest, error: null }
    )
    assert.equal(
      (await readdir(f.profile)).filter(name => name.startsWith('before-identity-reconciliation-'))
        .length,
      1
    )
    assert.deepEqual(f.db.db.pragma('foreign_key_check'), [])
    await f.scan()
    assert.equal(f.db.list(query).total, 1)
    assert.equal(
      (await readdir(f.profile)).filter(name => name.startsWith('before-identity-reconciliation-'))
        .length,
      1
    )
  } finally {
    await f.close()
  }
})

test('a genuine same-path physical replacement is a new file and retires only the displaced location during arrivals', async () => {
  const f = await fixture()
  try {
    const original = await f.add()
    f.db.updateDecision([{ id: original.id, revision: original.revision }], 'category', 'Dembow')
    await rename(original.path, path.join(f.root, 'original-held.wav'))
    await writeFile(
      original.path,
      wav({
        title: 'Replacement fixture',
        artist: 'Different fixture',
        genre: 'Pop',
      })
    )
    const info = await f.helper.inspect(original.path)
    f.scanner.startArrivals([
      {
        source: f.source,
        path: original.path,
        stamp: `${physicalKey(info)}|${signature(info)}`,
      },
    ])
    await f.scanner.wait()
    assert.equal(f.scanner.progress?.status, 'completed')
    const active = f.db.list({ ...query, view: 'practice' }).tracks
    assert.equal(active.length, 1)
    assert.notEqual(active[0]!.id, original.id)
    assert.equal(active[0]!.title, 'Replacement fixture')
    assert.equal(active[0]!.manual, false)
    assert.equal(f.db.get(original.id)!.availability, 'missing')
    assert.equal(f.db.get(original.id)!.category, 'Dembow')
  } finally {
    await f.close()
  }
})

test('same-path replacement preserves an older physical file through a remaining hard-link location', async () => {
  const f = await fixture()
  try {
    const initial = await f.add(),
      alternate = path.join(f.audio, 'remaining-hard-link.wav')
    await link(initial.path, alternate)
    await f.scan()
    const original = f.db.get(initial.id)!
    await rename(original.path, path.join(f.root, 'old-canonical-held.wav'))
    await writeFile(
      original.path,
      wav({
        title: 'Replacement fixture',
        artist: 'Different fixture',
        genre: 'Pop',
      })
    )
    const info = await f.helper.inspect(original.path)
    f.scanner.startArrivals([
      {
        source: f.source,
        path: original.path,
        stamp: `${physicalKey(info)}|${signature(info)}`,
      },
    ])
    await f.scanner.wait()
    assert.equal(f.scanner.progress?.status, 'completed')
    assert.equal(f.db.get(original.id)!.availability, 'available')
    assert.notEqual(f.db.get(original.id)!.path, original.path)
    assert.equal(f.db.list({ ...query, view: 'practice' }).total, 2)
    assert.equal(
      (
        f.db.db
          .prepare('SELECT COUNT(*) n FROM locations WHERE fileId=? AND path=? AND available=1')
          .get(original.id, original.path) as { n: number }
      ).n,
      0
    )
  } finally {
    await f.close()
  }
})

test('catalogue removal stays suppressed across device churn without reading the original again', async () => {
  const f = await fixture()
  try {
    const original = await f.add(),
      info = await f.helper.inspect(original.path),
      key = physicalKey(info)
    f.db.removeFromLibrary(
      { id: original.id, revision: original.revision },
      'Synthetic permission failure',
      'original-kept'
    )
    f.db.db.prepare('UPDATE files SET physicalKey=? WHERE id=?').run(f.oldDevice(key), original.id)
    // The scan's only content reader is deliberately unusable after removal.
    const scanner = new Scanner(
      f.db,
      f.helper,
      path.join(f.root, 'nonexistent-metadata-worker.cjs'),
      () => {}
    )
    scanner.start('smart')
    await scanner.wait()
    assert.equal(scanner.progress?.status, 'completed')
    assert.equal(scanner.progress?.newFiles, 0)
    assert.equal(f.db.list(query).total, 0)
    assert.equal(f.db.get(original.id)!.availability, 'removed')
    assert.deepEqual(scanner.progress?.issues, [])
  } finally {
    await f.close()
  }
})

test('a restored recovery journal preserves its referenced alias ID while local decisions merge', async () => {
  const f = await fixture()
  try {
    const original = await f.add()
    f.db.updateDecision([{ id: original.id, revision: original.revision }], 'category', 'Dembow')
    const { aliasId, currentKey } = await legacyAlias(f, original.id),
      batch = randomUUID(),
      journalDirectory = path.join(f.profile, 'track-trash'),
      journal = JSON.stringify({
        version: 1,
        id: batch,
        entries: [{ id: aliasId, status: 'restored' }],
      })
    await mkdir(journalDirectory)
    const journalPath = path.join(journalDirectory, batch + '.json')
    await writeFile(journalPath, journal)
    await f.scan()
    assert.equal(f.db.list(query).total, 1)
    assert.equal(f.db.get(original.id), undefined)
    assert.equal(f.db.findPhysical(currentKey)!.id, aliasId)
    assert.equal(f.db.get(aliasId)!.manual, true)
    assert.equal(f.db.get(aliasId)!.category, 'Dembow')
    assert.equal(await readFile(journalPath, 'utf8'), journal)
    assert.equal(
      (
        f.db.db.prepare('SELECT COUNT(*) n FROM decisions WHERE fileId=?').get(aliasId) as {
          n: number
        }
      ).n,
      1
    )
    assert.deepEqual(f.db.db.pragma('foreign_key_check'), [])
  } finally {
    await f.close()
  }
})

test('two recovery-linked alias IDs refuse automatic merging without deleting either history', async () => {
  const f = await fixture()
  try {
    const original = await f.add(),
      { aliasId, currentKey } = await legacyAlias(f, original.id),
      batch = randomUUID(),
      journalDirectory = path.join(f.profile, 'track-trash'),
      journal = JSON.stringify({
        version: 1,
        id: batch,
        entries: [
          { id: original.id, status: 'restored' },
          { id: aliasId, status: 'restored' },
        ],
      })
    await mkdir(journalDirectory)
    const journalPath = path.join(journalDirectory, batch + '.json')
    await writeFile(journalPath, journal)
    assert.throws(() => f.db.resolvePhysical(currentKey, original.path), /recovery history/i)
    assert.ok(f.db.get(original.id))
    assert.ok(f.db.get(aliasId))
    assert.equal(f.db.list(query).total, 2)
    assert.equal(await readFile(journalPath, 'utf8'), journal)
    assert.equal(
      (await readdir(f.profile)).filter(name => name.startsWith('before-identity-reconciliation-'))
        .length,
      0
    )
    assert.deepEqual(f.db.db.pragma('foreign_key_check'), [])
  } finally {
    await f.close()
  }
})

test('malformed recovery history holds alias consolidation before catalogue changes', async () => {
  const f = await fixture()
  try {
    const original = await f.add(),
      { aliasId, currentKey } = await legacyAlias(f, original.id),
      journalDirectory = path.join(f.profile, 'duplicate-cleanup'),
      batch = randomUUID()
    await mkdir(journalDirectory)
    const journalPath = path.join(journalDirectory, batch + '.json')
    await writeFile(journalPath, '{malformed synthetic history')
    assert.throws(
      () => f.db.resolvePhysical(currentKey, original.path),
      /could not safely check saved Trash recovery history/i
    )
    assert.ok(f.db.get(original.id))
    assert.ok(f.db.get(aliasId))
    assert.equal(f.db.list(query).total, 2)
    assert.equal(await readFile(journalPath, 'utf8'), '{malformed synthetic history')
    assert.equal(
      (await readdir(f.profile)).filter(name => name.startsWith('before-identity-reconciliation-'))
        .length,
      0
    )
    assert.deepEqual(f.db.db.pragma('foreign_key_check'), [])
  } finally {
    await f.close()
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  rename,
  realpath,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { LibraryDB } from '../src/db'
import { Organization } from '../src/organization'
import { Classifier } from '../src/classifier'
import { Preparation } from '../src/preparation'
import { NativeHelper } from '../src/native'
import { Scanner } from '../src/scanner'
import type { DuplicateHashes } from '../src/duplicate-hashes'
import type { Availability, LibraryQuery } from '../src/shared'
// @ts-expect-error Synthetic generator is plain JavaScript.
import { wav } from '../scripts/fixtures.mjs'

const query: LibraryQuery = {
  search: '',
  view: 'all',
  sort: 'title',
  direction: 'asc',
  offset: 0,
  limit: 100,
}
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dj-library-removal-synthetic-')))
  const audio = path.join(root, 'audio')
  await mkdir(audio)
  const profile = path.join(root, 'profile'),
    db = new LibraryDB(profile),
    source = db.addSource(audio)
  const organization = new Organization(db),
    classifier = new Classifier(db, () => {})
  const prep = new Preparation(
    db,
    {} as NativeHelper,
    { running: false, state: () => null } as unknown as DuplicateHashes,
    () => {}
  )
  const add = (title: string, availability: Availability = 'available') => {
    const id = randomUUID(),
      now = new Date().toISOString()
    db.register(
      {
        id,
        physicalKey: id,
        signature: id,
        path: path.join(audio, id + '.wav'),
        filename: title + '.wav',
        sourceId: source.id,
        title,
        artist: 'Synthetic only',
        genre: 'Pop',
        bpm: 100,
        year: 2020,
        duration: 180,
        format: 'WAV',
        bitrate: 1411,
        sampleRate: 44100,
        key: null,
        size: 128,
        availability,
        addedAt: now,
        updatedAt: now,
        metadataError: null,
        tags: {},
      },
      'initial'
    )
    return id
  }
  const change = (id: string) => ({ id, revision: db.get(id)!.revision })
  return {
    root,
    audio,
    profile,
    db,
    source,
    organization,
    classifier,
    prep,
    add,
    change,
    close: async () => {
      await organization.close()
      await classifier.close()
      await prep.close()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('catalog-only removal preserves metadata and memberships while staying hidden from every visible library view', async () => {
  const f = await fixture()
  try {
    const kept = f.add('A available'),
      removed = f.add('B 100% kept original'),
      earlierTrash = f.add('C earlier duplicate Trash', 'trashed'),
      laterTrash = f.add('D earlier selected Trash', 'trashed')
    f.classifier.runNow()
    await f.classifier.wait()
    await f.organization.organize()
    const playlist = f.organization.playlistCreate({
      name: 'Practice',
      kind: 'playlist',
    })
    f.organization.playlistMembers({
      id: playlist.id,
      ids: [kept, removed],
      action: 'add',
    })
    f.db.db
      .prepare('INSERT INTO playlist_approvals VALUES(?,?,?)')
      .run(removed, 'synthetic-old-approval', new Date().toISOString())
    const before = f.db.get(removed)!
    f.db.removeFromLibrary(
      f.change(removed),
      'macOS could not move the selected file',
      'original-kept'
    )
    const after = f.db.get(removed)!
    assert.equal(after.availability, 'removed')
    assert.equal(after.revision, before.revision + 1)
    for (const key of ['path', 'artist', 'title', 'genre', 'tags', 'category', 'manual'] as const)
      assert.deepEqual(after[key], before[key])
    assert.equal(f.db.list(query).total, 1)
    for (const view of [
      'practice',
      'new',
      'source',
      'category',
      'unavailable',
      'review',
      'tag',
      'trash',
    ] as const)
      assert.equal(
        f.db
          .list({
            ...query,
            view,
            value:
              view === 'source'
                ? f.source.id
                : view === 'category'
                  ? 'Pop'
                  : view === 'tag'
                    ? 'genre:Pop'
                    : undefined,
          })
          .tracks.some(track => track.id === removed),
        false
      )
    assert.equal(f.db.list({ ...query, view: 'playlist', value: playlist.id }).total, 1)
    assert.equal(f.organization.state().playlists[0]!.count, 1)
    assert.equal(f.organization.state().practiceCount, 1)
    assert.equal(f.db.sources()[0]!.fileCount, 1)
    assert.equal((await f.prep.preview({ scope: 'all', ids: [] })).total, 1)
    assert.equal(
      (await f.prep.reviewList({ ...query, view: 'review' })).tracks.some(
        track => track.id === removed
      ),
      false
    )
    assert.equal(f.db.summary().files, 1)
    assert.equal(f.db.summary().trash, 2)
    assert.deepEqual(
      f.db.list({ ...query, view: 'trash' }).tracks.map(track => track.id),
      [earlierTrash, laterTrash]
    )
    assert.equal(f.db.list({ ...query, view: 'trash', search: '100%' }).total, 0)
    assert.equal(f.db.list({ ...query, view: 'trash', search: 'earlier duplicate' }).total, 1)
    assert.equal(
      f.db.list({ ...query, view: 'trash', offset: 1, limit: 1 }).tracks[0]!.id,
      laterTrash
    )
    assert.deepEqual(
      f.db.db
        .prepare('SELECT originalAvailability,locationState FROM library_removals WHERE fileId=?')
        .get(removed),
      { originalAvailability: 'available', locationState: 'original-kept' }
    )
    assert.equal(
      f.db.db.prepare('SELECT 1 FROM playlist_approvals WHERE fileId=?').get(removed),
      undefined
    )
    assert.equal(
      f.db.db.prepare('SELECT 1 FROM classification_queue WHERE fileId=?').get(removed),
      undefined
    )
    assert.throws(
      () =>
        f.organization.tagsUpdate({
          changes: [f.change(removed)],
          group: 'genre',
          value: 'Salsa',
          action: 'add',
        }),
      /selection changed/
    )
    assert.throws(
      () => f.db.updateDecision([f.change(removed)], 'category', 'Salsa'),
      /selection changed/
    )
  } finally {
    await f.close()
  }
})

test('restoring a removed entry preserves original availability and exact location flags without granting approval', async () => {
  const f = await fixture()
  try {
    const id = f.add('Synthetic damaged original', 'corrupt'),
      otherSource = f.db.addSource(path.join(f.root, 'other-source'))
    f.db.observe(id, otherSource.id, path.join(otherSource.path, 'history.wav'), 'old')
    f.db.db
      .prepare('UPDATE locations SET available=0 WHERE fileId=? AND sourceId=?')
      .run(id, otherSource.id)
    const locations = f.db.db
      .prepare(
        'SELECT sourceId,path,available FROM locations WHERE fileId=? ORDER BY sourceId,path'
      )
      .all(id)
    const original = f.change(id)
    f.db.removeFromLibrary(original, 'Read-only original', 'original-kept')
    assert.equal(
      (
        f.db.db.prepare('SELECT SUM(available) n FROM locations WHERE fileId=?').get(id) as {
          n: number
        }
      ).n,
      0
    )
    assert.throws(() => f.db.removeFromLibrary(original, 'Stale', 'original-kept'), /track changed/)
    assert.throws(() => f.db.restoreToLibrary(original), /entry changed/)
    f.db.restoreToLibrary(f.change(id))
    assert.equal(f.db.get(id)!.availability, 'corrupt')
    assert.deepEqual(
      f.db.db
        .prepare(
          'SELECT sourceId,path,available FROM locations WHERE fileId=? ORDER BY sourceId,path'
        )
        .all(id),
      locations
    )
    assert.equal(f.db.get(id)!.revision, original.revision + 2)
    assert.equal(
      f.db.db.prepare('SELECT 1 FROM library_removals WHERE fileId=?').get(id),
      undefined
    )
    assert.equal(
      f.db.db.prepare('SELECT 1 FROM library_removal_locations WHERE fileId=?').get(id),
      undefined
    )
    assert.equal(
      f.db.db.prepare('SELECT 1 FROM playlist_approvals WHERE fileId=?').get(id),
      undefined
    )
    assert.throws(() => f.db.restoreToLibrary(f.change(id)), /entry changed/)
  } finally {
    await f.close()
  }
})

test('register, observe and source reconciliation never revive or relocate removed physical instances', async () => {
  const f = await fixture()
  try {
    const id = f.add('Hidden physical file')
    const original = f.db.get(id)! as ReturnType<typeof f.db.get> & {
      physicalKey: string
      signature: string
    }
    f.db.removeFromLibrary(f.change(id), 'Unknown native outcome', 'unconfirmed')
    f.db.register(
      {
        ...original!,
        physicalKey: original!.physicalKey,
        signature: 'changed-synthetic-content',
        path: path.join(f.audio, 'renamed.wav'),
        filename: 'renamed.wav',
        availability: 'available',
        updatedAt: new Date().toISOString(),
      },
      'rescan'
    )
    f.db.observe(id, f.source.id, path.join(f.audio, 'new-location.wav'), 'rescan')
    assert.equal(f.db.get(id)!.path, original!.path)
    assert.equal(f.db.get(id)!.availability, 'removed')
    assert.equal(
      f.db.db
        .prepare('SELECT 1 FROM locations WHERE fileId=? AND path=?')
        .get(id, path.join(f.audio, 'new-location.wav')),
      undefined
    )
    f.db.finishSource(f.source.id, 'rescan', true)
    assert.equal(f.db.get(id)!.availability, 'removed')
    assert.equal(f.db.get(id)!.path, original!.path)
    assert.equal(
      (
        f.db.db.prepare('SELECT signature FROM files WHERE id=?').get(id) as {
          signature: string
        }
      ).signature,
      original!.signature
    )
  } finally {
    await f.close()
  }
})

test('real synthetic rescans and source disconnection keep catalog-removed originals out until explicit restore', async () => {
  const f = await fixture()
  const helper = new NativeHelper(path.resolve('dist/native/organizer-helper'))
  const scanner = new Scanner(f.db, helper, path.resolve('dist/metadata-worker.cjs'), () => {})
  const scan = async () => {
    scanner.start('discovery')
    await scanner.wait()
  }
  try {
    const file = path.join(f.audio, 'Retained original.wav'),
      bytes = wav({
        title: 'Synthetic retained original',
        artist: 'Synthetic only',
        genre: 'Pop',
      })
    await writeFile(file, bytes)
    await scan()
    const original = f.db.list(query).tracks[0]!
    f.db.removeFromLibrary(f.change(original.id), 'Original stays on disk', 'original-kept')
    await writeFile(
      file,
      wav({
        title: 'Synthetic in-place changed bytes',
        artist: 'Synthetic only',
        genre: 'Pop',
        frequency: 660,
      })
    )
    const changedBytes = await readFile(file)
    await scan()
    assert.equal(f.db.summary().files, 0)
    assert.equal(f.db.summary().trash, 0)
    assert.equal(f.db.list({ ...query, view: 'trash' }).total, 0)
    assert.equal(f.db.get(original.id)!.availability, 'removed')
    assert.ok((scanner.progress?.skipped || 0) >= 1)
    const away = f.audio + '-offline'
    await rename(f.audio, away)
    await scan()
    assert.equal(f.db.get(original.id)!.availability, 'removed')
    await rename(away, f.audio)
    f.db.restoreToLibrary(f.change(original.id))
    await scan()
    assert.equal(f.db.summary().files, 1)
    assert.equal(f.db.summary().trash, 0)
    assert.equal(f.db.get(original.id)!.title, 'Synthetic in-place changed bytes')
    assert.equal(
      createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
      createHash('sha256').update(changedBytes).digest('hex')
    )
  } finally {
    scanner.cancel()
    await scanner.wait()
    helper.close()
    await f.close()
  }
})

test('schema 7 upgrades to 8 with a consistent backup and retained legacy Trash visibility', async () => {
  const f = await fixture()
  let reopened: LibraryDB | undefined
  try {
    f.add('Existing earlier Trash', 'trashed')
    await f.organization.close()
    await f.classifier.close()
    await f.prep.close()
    f.db.db.exec(
      'DROP TABLE library_removal_locations;DROP TABLE library_removals;PRAGMA user_version=7;'
    )
    f.db.close()
    reopened = new LibraryDB(f.profile)
    assert.equal(reopened.db.pragma('user_version', { simple: true }), 8)
    assert.equal(reopened.list({ ...query, view: 'trash' }).total, 1)
    assert.equal(reopened.summary().files, 0)
    assert.equal(reopened.summary().trash, 1)
    const backupFile = (await readdir(f.profile)).find(name => name.startsWith('before-schema-8-'))!
    const backup = new Database(path.join(f.profile, backupFile), {
      readonly: true,
    })
    try {
      assert.equal(backup.pragma('user_version', { simple: true }), 7)
      assert.equal(backup.pragma('quick_check', { simple: true }), 'ok')
    } finally {
      backup.close()
    }
  } finally {
    reopened?.close()
    if (f.db.db.open) f.db.close()
    await rm(f.root, { recursive: true, force: true })
  }
})

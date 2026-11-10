import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, copyFile, rename, stat, symlink, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { LibraryDB } from '../src/db'
import { NativeHelper } from '../src/native'
import { Scanner } from '../src/scanner'
import { Classifier } from '../src/classifier'
import { DuplicateHashes } from '../src/duplicate-hashes'
import { Preparation } from '../src/preparation'
import { Rekordbox } from '../src/rekordbox'
import { Automation, SettledFiles } from '../src/automation'
import { ManagedSync, sha256 } from '../src/managed-sync'
import { requestSchemas } from '../src/shared'
import { Organization } from '../src/organization'
// @ts-expect-error Synthetic generator is plain JavaScript.
import { wav } from '../scripts/fixtures.mjs'
async function fixture() {
  const root = path.resolve('../../work/automation-' + randomUUID())
  const audio = path.join(root, 'audio')
  await mkdir(audio, { recursive: true })
  const db = new LibraryDB(path.join(root, 'profile'))
  const helper = new NativeHelper(path.resolve('dist/native/organizer-helper'))
  const scanner = new Scanner(db, helper, path.resolve('dist/metadata-worker.cjs'), () => {})
  const classifier = new Classifier(db, () => {})
  const hashes = new DuplicateHashes(db, helper, path.resolve('dist/hash-worker.cjs'), () => {})
  const prep = new Preparation(db, helper, hashes, () => {})
  const rb = new Rekordbox(db, helper, path.resolve('dist/xml-worker.cjs'), () => {})
  await rb.initialize()
  const source = db.addSource(audio)
  let blocked = true
  const auto = new Automation(
    db,
    helper,
    scanner,
    classifier,
    hashes,
    prep,
    rb,
    () => blocked,
    () => {},
    '0.8.0'
  )
  const folder = await auto.folder(root)
  const options = {
    enabled: true,
    sourceIds: [source.id],
    autoApprove: true,
    syncEnabled: true,
    watchRekordbox: false,
  }
  auto.configure(options)
  return {
    root,
    audio,
    db,
    helper,
    scanner,
    classifier,
    hashes,
    prep,
    rb,
    source,
    auto,
    options,
    folder: folder.config.syncDirectory!,
    unblock: () => {
      blocked = false
    },
    close: async () => {
      await auto.close()
      await scanner.wait()
      await prep.close()
      await hashes.close()
      await classifier.close()
      await rb.close()
      helper.close()
      db.close()
    },
  }
}
const tone = (title = 'New arrival') => wav({ title, artist: 'Synthetic automation', genre: 'Pop' })
test('automatic arrivals ignore catalog-removed physical instances even after their contents change', async () => {
  const f = await fixture()
  try {
    const file = path.join(f.audio, 'kept-original.wav')
    await writeFile(file, tone('Synthetic first version'))
    f.unblock()
    await f.auto.check(1000)
    await f.auto.check(22000)
    const track = f.db.list({
      search: '',
      view: 'all',
      sort: 'title',
      direction: 'asc',
      offset: 0,
      limit: 10,
    }).tracks[0]!
    assert.ok(track)
    f.db.removeFromLibrary(
      { id: track.id, revision: track.revision },
      'Retain original outside active library',
      'original-kept'
    )
    const changed = tone('Synthetic in-place replacement with changed metadata')
    await writeFile(file, changed)
    await f.auto.check(55000)
    await f.auto.check(90000)
    assert.equal(f.auto.state().pending, 0)
    assert.equal(f.db.summary().files, 0)
    assert.equal(f.db.summary().trash, 0)
    assert.equal(f.db.get(track.id)!.availability, 'removed')
    assert.deepEqual(await readFile(file), changed)
  } finally {
    await f.close()
  }
})
test('settling resets on modification, disappearance and restart', () => {
  const s = new SettledFiles()
  assert.equal(s.observe('a', 'one', 0), false)
  assert.equal(s.observe('a', 'one', 19000), false)
  assert.equal(s.observe('a', 'two', 20000), false)
  assert.equal(s.observe('a', 'two', 40000), true)
  s.retain(new Set())
  assert.equal(s.observe('a', 'two', 50000), false)
  s.clear()
  assert.equal(s.observe('a', 'two', 80000), false)
  assert.equal(
    requestSchemas.automationConfigure.safeParse({
      enabled: true,
      sourceIds: [],
      autoApprove: true,
      syncEnabled: true,
      watchRekordbox: false,
      syncDirectory: '/tmp/injection',
    }).success,
    false
  )
})
test('new downloads settle, classify, choose one copy and update a stable XML without touching audio', async () => {
  const f = await fixture()
  try {
    const file = path.join(f.audio, 'first.wav')
    await writeFile(file, tone())
    await copyFile(file, path.join(f.audio, 'extra.wav'))
    await writeFile(path.join(f.audio, 'incomplete.wav.part'), tone('Partial'))
    await mkdir(path.join(f.audio, 'nested'))
    await writeFile(
      path.join(f.audio, 'nested', 'unknown.wav'),
      wav({ title: 'Unknown', artist: 'Synthetic', genre: '' })
    )
    await symlink(file, path.join(f.audio, 'link.wav'))
    f.unblock()
    await f.auto.check(1000)
    assert.equal(f.db.summary().files, 0)
    assert.equal(f.auto.state().pending, 3)
    await f.auto.check(22000)
    assert.equal(f.auto.state().error, null)
    assert.equal(f.db.summary().files, 3)
    assert.equal(f.auto.state().sync?.tracks, 1)
    assert.equal(f.auto.state().sync?.held, 2)
    assert.equal(f.auto.state().sync?.practiceTracks, 3)
    const xmlPath = path.join(f.folder, 'rekordbox.xml')
    const xml = await readFile(xmlPath, 'utf8')
    assert.match(xml, /New arrival/)
    assert.doesNotMatch(xml, /Partial/)
    const stamp = (await stat(xmlPath)).mtimeMs
    await f.auto.check(55000)
    assert.equal((await stat(xmlPath)).mtimeMs, stamp)
    assert.deepEqual(await readFile(file), tone())
    assert.equal((await f.prep.duplicates(0)).unresolved, 0)
    const id = (
      f.db.db.prepare('SELECT id FROM files WHERE path=?').get(file) as {
        id: string
      }
    ).id
    const track = f.db.get(id)!
    f.db.updateDecision([{ id, revision: track.revision }], 'category', 'Jersey Club')
    await f.auto.check(90000)
    assert.equal(f.db.get(id)?.category, 'Jersey Club')
    assert.equal(f.db.get(id)?.manual, true)
  } finally {
    await f.close()
  }
})
test('managed practice mirrors current multi-genre labels and nested personal playlists when strict preparation is blocked', async () => {
  const f = await fixture()
  const organization = new Organization(f.db)
  try {
    const pop = path.join(f.audio, 'known.wav')
    const unknown = path.join(f.audio, 'unknown.wav')
    await writeFile(pop, tone('Practice known'))
    await writeFile(unknown, wav({ title: 'Held unknown', artist: 'Synthetic', genre: '' }))
    f.prep.autoChoose = async () => {
      throw new Error('Synthetic strict duplicate block')
    }
    f.unblock()
    await f.auto.check(1000)
    await f.auto.check(22000)
    assert.equal(f.auto.state().sync?.tracks, 0)
    assert.equal(f.auto.state().sync?.practiceTracks, 2)
    assert.match(f.auto.state().sync?.preparedIssue || '', /Synthetic strict duplicate block/)
    assert.equal(
      (
        f.db.db.prepare('SELECT COUNT(*) n FROM playlist_approvals').get() as {
          n: number
        }
      ).n,
      0
    )
    const file = (
      f.db.db.prepare('SELECT id FROM files WHERE path=?').get(pop) as {
        id: string
      }
    ).id
    const beforeRevision = f.db.get(file)!.revision
    // This derived tag update deliberately does not change files.revision.
    f.db.db
      .prepare("INSERT INTO organization_tags VALUES(?,'genre','House / Dance','automatic')")
      .run(file)
    const folder = organization.playlistCreate({
      name: 'Thursday',
      kind: 'folder',
    })
    const first = organization.playlistCreate({
      name: 'Warmup',
      parentId: folder.id,
      kind: 'playlist',
    })
    const second = organization.playlistCreate({
      name: 'Favorites',
      kind: 'playlist',
    })
    for (const list of [first, second])
      organization.playlistMembers({ id: list.id, action: 'add', ids: [file] })
    await f.auto.check(55000)
    const xml = await readFile(path.join(f.folder, 'rekordbox.xml'), 'utf8')
    for (const name of [
      'Practice Library',
      'All Practice Tracks',
      'Genres',
      'Pop',
      'House / Dance',
      'Unsorted',
      'My Playlists',
      'Thursday',
      'Warmup',
      'Favorites',
      'Prepared playlists',
    ])
      assert.ok(xml.includes(`Name="${name}"`), name)
    assert.match(xml, /Name="All Practice Tracks" KeyType="0" Entries="2"/)
    assert.match(xml, /Name="Unsorted" KeyType="0" Entries="1"/)
    assert.match(xml, /Name="Prepared playlists" Count="0"/)
    assert.equal(f.db.get(file)!.revision, beforeRevision)
    const originalID = /<TRACK ([^>]*Name="Practice known"[^>]*)>/
      .exec(xml)![1]!
      .match(/TrackID="(\d+)"/)![1]
    organization.playlistRename({ id: first.id, name: 'Openers' })
    await f.auto.check(90000)
    const next = await readFile(path.join(f.folder, 'rekordbox.xml'), 'utf8')
    assert.match(next, /Name="Openers"/)
    assert.doesNotMatch(next, /Name="Warmup"/)
    assert.equal(
      /<TRACK ([^>]*Name="Practice known"[^>]*)>/.exec(next)![1]!.match(/TrackID="(\d+)"/)![1],
      originalID
    )
    assert.deepEqual(await readFile(pop), tone('Practice known'))
  } finally {
    await organization.close()
    await f.close()
  }
})
test('practice publication skips missing and stale identities without mutating their availability or approving them', async () => {
  const f = await fixture()
  try {
    const missing = path.join(f.audio, 'missing.wav')
    const good = path.join(f.audio, 'good.wav')
    await writeFile(missing, tone('Missing synthetic'))
    await writeFile(good, tone('Current synthetic'))
    f.scanner.start('discovery')
    await f.scanner.wait()
    await rename(missing, path.join(f.root, 'outside-source.wav'))
    f.unblock()
    await f.auto.check(1000)
    const state = f.auto.state()
    assert.equal(state.sync?.practiceTracks, 1)
    assert.equal(state.sync?.practiceOmitted, 1)
    assert.equal(state.sync?.tracks, 0)
    assert.ok(state.sync?.preparedIssue)
    const xml = await readFile(path.join(f.folder, 'rekordbox.xml'), 'utf8')
    assert.match(xml, /Current synthetic/)
    assert.doesNotMatch(xml, /Missing synthetic/)
    assert.equal(
      (
        f.db.db.prepare('SELECT availability FROM files WHERE path=?').get(missing) as {
          availability: string
        }
      ).availability,
      'available'
    )
  } finally {
    await f.close()
  }
})
test('growing downloads and interrupted passes never mark unvisited catalog files missing', async () => {
  const f = await fixture()
  try {
    const old = path.join(f.audio, 'old.wav')
    await writeFile(old, tone('Old'))
    f.scanner.start('discovery')
    await f.scanner.wait()
    await rename(old, path.join(f.root, 'old-held.wav'))
    const next = path.join(f.audio, 'next.wav')
    await writeFile(next, tone('Growing'))
    f.unblock()
    await f.auto.check(1000)
    await writeFile(next, tone('Finished'))
    await f.auto.check(30000)
    assert.equal(f.db.summary().files, 1)
    await f.auto.check(51000)
    assert.equal(f.db.summary().files, 2)
    const row = f.db.db.prepare('SELECT availability FROM files WHERE path=?').get(old) as {
      availability: string
    }
    assert.equal(row.availability, 'available')
    assert.equal(f.scanner.progress?.incremental, true)
    assert.equal(f.scanner.progress?.coverage, 'partial')
    f.auto.configure({ ...f.options, enabled: false })
    await f.auto.check(90000)
    assert.equal(f.auto.state().active, false)
  } finally {
    await f.close()
  }
})
test('approval opt-out holds ready tracks until batch approval, disabled sources are not scanned', async () => {
  const f = await fixture()
  try {
    f.auto.configure({ ...f.options, enabled: false })
    f.auto.configure({ ...f.options, autoApprove: false })
    await writeFile(path.join(f.audio, 'one.wav'), tone())
    f.unblock()
    await f.auto.check(0)
    await f.auto.check(21000)
    assert.equal(f.auto.state().sync?.tracks, 0)
    assert.equal(f.auto.state().sync?.awaitingApproval, 1)
    const preview = await f.prep.preview({ scope: 'all', ids: [] })
    await f.prep.approve(preview.token)
    await f.auto.check(55000)
    assert.equal(f.auto.state().sync?.tracks, 1)
    f.db.sourceEnabled(f.source.id, false)
    await writeFile(path.join(f.audio, 'two.wav'), tone('Two'))
    await f.auto.check(90000)
    await f.auto.check(120000)
    assert.equal(f.db.summary().files, 1)
    assert.equal(f.auto.state().sync?.tracks, 0)
  } finally {
    await f.close()
  }
})
test('watched native XML refreshes after settling; invalid XML retains previous snapshot', async () => {
  const f = await fixture()
  try {
    const file = path.join(f.audio, 'one.wav')
    await writeFile(file, tone())
    f.scanner.start('discovery')
    await f.scanner.wait()
    const input = path.join(f.root, 'collection.xml')
    const xml = (name: string) =>
      `<?xml version="1.0"?><DJ_PLAYLISTS Version="1.0.0"><PRODUCT Name="rekordbox" Version="7" Company="AlphaTheta"/><COLLECTION Entries="1"><TRACK TrackID="1" Name="${name}" Artist="Synthetic automation" Location="${pathToFileURL(file).href}"/></COLLECTION><PLAYLISTS><NODE Type="0" Name="ROOT" Count="0"/></PLAYLISTS></DJ_PLAYLISTS>`
    await writeFile(input, xml('New arrival'))
    let candidates = await f.rb.find([input])
    await f.rb.import(candidates.candidates[0]!.id)
    f.auto.configure({ ...f.options, enabled: false })
    f.auto.configure({ ...f.options, watchRekordbox: true })
    f.unblock()
    await f.auto.check(0)
    await f.auto.check(21000)
    assert.equal(f.auto.state().error, null)
    await writeFile(input, xml('Updated'))
    await f.auto.check(50000)
    await f.auto.check(71000)
    assert.equal(
      (
        f.db.db
          .prepare(
            'SELECT attrs FROM rb_tracks t JOIN rb_snapshots s ON s.id=t.snapshotId WHERE s.active=1'
          )
          .get() as { attrs: string }
      ).attrs.includes('Updated'),
      true
    )
    const before = (
      f.db.db.prepare('SELECT id FROM rb_snapshots WHERE active=1').get() as {
        id: string
      }
    ).id
    await writeFile(input, '<truncated>')
    await f.auto.check(100000)
    await f.auto.check(121000)
    assert.match(f.auto.state().error!, /not a valid/)
    assert.equal(
      (
        f.db.db.prepare('SELECT id FROM rb_snapshots WHERE active=1').get() as {
          id: string
        }
      ).id,
      before
    )
  } finally {
    await f.close()
  }
})
test('managed XML publication preserves previous version, refuses foreign edits and links, and can cancel', async () => {
  const f = await fixture()
  try {
    const writer = new ManagedSync(f.db.directory, f.helper)
    const a = '<first/>'
    const b = '<second/>'
    await writer.publish(f.folder, a, null, () => {})
    await assert.rejects(
      writer.publish(f.folder, b, sha256(a), () => {
        throw new Error('Cancelled')
      }),
      /Cancelled/
    )
    assert.equal(await readFile(path.join(f.folder, 'rekordbox.xml'), 'utf8'), a)
    await writer.publish(f.folder, b, sha256(a), () => {})
    assert.equal(await readFile(path.join(f.folder, 'rekordbox.previous.xml'), 'utf8'), a)
    await writeFile(path.join(f.folder, 'rekordbox.xml'), 'foreign')
    await assert.rejects(
      writer.publish(f.folder, a, sha256(b), () => {}),
      /outside/
    )
    await rm(path.join(f.folder, 'rekordbox.xml'))
    const external = path.join(f.root, 'external.xml')
    await writeFile(external, 'keep')
    await symlink(external, path.join(f.folder, 'rekordbox.xml'))
    await assert.rejects(
      writer.publish(f.folder, a, null, () => {}),
      /ordinary/
    )
    assert.equal(await readFile(external, 'utf8'), 'keep')
    await assert.rejects(f.auto.folder(f.audio), /outside your audio/)
  } finally {
    await f.close()
  }
})
test('automatic settings survive reopening but do not run until explicitly started', async () => {
  const f = await fixture()
  try {
    f.auto.configure({ ...f.options, enabled: false })
    const copy = new Automation(
      f.db,
      f.helper,
      f.scanner,
      f.classifier,
      f.hashes,
      f.prep,
      f.rb,
      () => false,
      () => {},
      '0.8.0'
    )
    assert.equal(copy.state().config.syncDirectory, f.folder)
    assert.equal(copy.state().config.enabled, false)
    assert.equal(copy.state().active, false)
    await copy.check()
    assert.equal(copy.state().lastCompletedAt, null)
    await copy.close()
  } finally {
    await f.close()
  }
})

test('pausing an in-flight folder pass stops ingestion and publication', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.audio, 'cancelled.wav'), tone())
    f.unblock()
    const running = f.auto.check(1000)
    assert.equal(f.auto.running, true)
    f.auto.configure({ ...f.options, enabled: false })
    await running
    assert.equal(f.db.summary().files, 0)
    assert.equal(f.auto.state().sync, null)
    assert.equal(f.auto.state().phase, 'Paused')
    assert.equal(f.auto.running, false)
  } finally {
    await f.close()
  }
})

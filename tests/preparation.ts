import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdir,
  writeFile,
  copyFile,
  readFile,
  appendFile,
  readdir,
  access,
  rm,
  link,
  symlink,
} from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import Database from 'better-sqlite3'
import { LibraryDB } from '../src/db'
import { NativeHelper } from '../src/native'
import { Scanner } from '../src/scanner'
import { Classifier } from '../src/classifier'
import { Rekordbox } from '../src/rekordbox'
import { DuplicateHashes, type CatalogFile } from '../src/duplicate-hashes'
import { DuplicateCleanup } from '../src/duplicate-cleanup'
import { bestCopy } from '../src/duplicate-choice'
import { Preparation } from '../src/preparation'
import { escapeXML, playlistFiles } from '../src/playlist-export'
import { requestSchemas } from '../src/shared'
// @ts-expect-error Deliberately plain JS synthetic generator.
import { wav } from '../scripts/fixtures.mjs'
const all = { scope: 'all' as const, ids: [] }
async function fixture() {
  const root = path.resolve('../../work/preparation-' + randomUUID())
  await mkdir(root, { recursive: true })
  const audio = path.join(root, 'audio')
  await mkdir(audio)
  const db = new LibraryDB(path.join(root, 'profile'))
  const helper = new NativeHelper(path.resolve('dist/native/organizer-helper'))
  const scanner = new Scanner(db, helper, path.resolve('dist/metadata-worker.cjs'), () => {})
  const classifier = new Classifier(db, () => {})
  const hashes = new DuplicateHashes(db, helper, path.resolve('dist/hash-worker.cjs'), () => {})
  const prep = new Preparation(db, helper, hashes, () => {}, classifier)
  const rb = new Rekordbox(db, helper, path.resolve('dist/xml-worker.cjs'), () => {})
  await rb.initialize()
  async function classify() {
    classifier.runNow()
    while (classifier.running) await new Promise(r => setTimeout(r, 5))
  }
  async function scan() {
    scanner.start('discovery')
    await scanner.wait()
    assert.equal(scanner.progress?.status, 'completed')
    await classify()
  }
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
    classify,
    scan,
    close: async () => {
      await prep.close()
      await hashes.close()
      await classifier.close()
      await rb.close()
      helper.close()
      db.close()
    },
  }
}
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
async function populate(f: Awaited<ReturnType<typeof fixture>>) {
  const a = path.join(f.audio, '01 Á & #100.wav')
  const copy = path.join(f.audio, '02 extra.wav')
  const other = path.join(f.audio, '03 alternate.wav')
  const remix = path.join(f.audio, '04 remix.wav')
  await writeFile(a, wav({ title: 'Á & "Track" <One>', artist: 'Synthetic Only', genre: 'Pop' }))
  await copyFile(a, copy)
  await writeFile(
    other,
    wav({
      title: 'Á & "Track" <One>',
      artist: 'Synthetic Only',
      genre: 'Pop',
      frequency: 440,
    })
  )
  await writeFile(
    remix,
    wav({
      title: 'Á & "Track" <One> (Remix)',
      artist: 'Synthetic Only',
      genre: 'Pop',
      frequency: 660,
    })
  )
  f.db.addSource(f.audio)
  await f.scan()
  return { a, copy, other, remix }
}
test('full-file duplicate hashes, version protection, keeper decisions and approved XML/M3U round trip', async () => {
  const f = await fixture()
  try {
    const paths = await populate(f)
    const before = await Promise.all(Object.values(paths).map(async p => sha(await readFile(p))))
    let plan = await f.prep.preview(all)
    assert.equal(plan.eligible, 0)
    await assert.rejects(f.prep.export(plan.token, f.root, 'test'), /Approve/)
    f.hashes.start()
    await f.hashes.wait()
    assert.equal(f.hashes.state()?.checked, 4)
    let groups = await f.prep.duplicates(0)
    assert.equal(groups.groups.filter(g => g.kind === 'exact').length, 1)
    assert.equal(groups.groups.filter(g => g.kind === 'candidate').length, 1)
    const exact = groups.groups.find(g => g.kind === 'exact')!
    const keeper = exact.members.find(m => m.track.path === paths.a)!.track.id
    const oldCandidate = groups.groups.find(g => g.kind === 'candidate')!
    await f.prep.resolve(exact.key, exact.fingerprint, keeper)
    await assert.rejects(
      f.prep.resolve(oldCandidate.key, oldCandidate.fingerprint, null),
      /changed/
    )
    groups = await f.prep.duplicates(0)
    const candidate = groups.groups.find(g => g.kind === 'candidate')!
    assert.equal(candidate.members.length, 2)
    assert.ok(candidate.members.every(m => !m.track.title?.includes('(Remix)')))
    await f.prep.resolve(candidate.key, candidate.fingerprint, null)
    plan = await f.prep.preview(all)
    assert.equal(plan.eligible, 3)
    assert.equal(plan.blocked, 1)
    assert.equal(plan.approved, 0)
    assert.equal(plan.reasons['Alternate copy omitted from playlists'], 1)
    await f.prep.approve(plan.token)
    plan = await f.prep.preview(all)
    assert.equal(plan.approved, 3)
    const exported = await f.prep.export(plan.token, f.root, 'test')
    assert.equal(exported.status, 'exported')
    assert.equal(exported.reportedImportedAt, null)
    const xml = await readFile(path.join(exported.directory, 'rekordbox.xml'), 'utf8')
    assert.ok(xml.includes('file://localhost/'))
    assert.ok(xml.includes('%23100.wav'))
    assert.ok(xml.includes('&amp;'))
    assert.ok(xml.includes('&quot;'))
    const parsed = await f.rb.find([path.join(exported.directory, 'rekordbox.xml')])
    assert.equal(parsed.candidates[0]?.valid, true, JSON.stringify(parsed))
    assert.equal(parsed.candidates[0]?.tracks, 3)
    assert.equal(parsed.candidates[0]?.playlists, 1)
    const m3u = await readFile(path.join(exported.directory, 'Pop.m3u8'), 'utf8')
    assert.equal(m3u.split('\n').filter(l => l.startsWith('/')).length, 3)
    assert.ok(m3u.includes(paths.remix))
    assert.ok(!m3u.includes(paths.copy))
    const manifest = JSON.parse(
      await readFile(path.join(exported.directory, 'manifest.json'), 'utf8')
    )
    assert.equal(manifest.files.find((x: any) => x.name === 'rekordbox.xml').sha256, sha(xml))
    f.prep.reportImported(exported.id)
    assert.ok(f.prep.history()[0]?.reportedImportedAt)
    const after = await Promise.all(Object.values(paths).map(async p => sha(await readFile(p))))
    assert.deepEqual(after, before)
    f.hashes.start()
    await f.hashes.wait()
    assert.equal(f.hashes.state()?.cached, 4)
    plan = await f.prep.preview(all)
    const second = await f.prep.export(plan.token, f.root, 'test')
    assert.notEqual(second.directory, exported.directory)
    assert.ok(await readFile(path.join(exported.directory, 'rekordbox.xml')))
  } finally {
    await f.close()
  }
})
test('stale previews and approvals reject changed category, new copies, disabled sources and changed file contents', async () => {
  const f = await fixture()
  try {
    await writeFile(path.join(f.audio, 'one.wav'), wav({ genre: 'Pop' }))
    const source = f.db.addSource(f.audio)
    await f.scan()
    f.hashes.start()
    await f.hashes.wait()
    let plan = await f.prep.preview(all)
    assert.equal(plan.eligible, 1)
    const track = f.db.db.prepare('SELECT * FROM files').get() as CatalogFile
    f.db.updateDecision([{ id: track.id, revision: track.revision }], 'category', 'Dance')
    await f.classify()
    await assert.rejects(f.prep.approve(plan.token), /changed/)
    plan = await f.prep.preview(all)
    await f.prep.approve(plan.token)
    plan = await f.prep.preview(all)
    assert.equal(plan.approved, 1)
    await appendFile(track.path, Buffer.from('changed'))
    await assert.rejects(f.prep.export(plan.token, f.root, 'test'), /changed/)
    assert.equal(f.prep.history().length, 0)
    await f.scan()
    plan = await f.prep.preview(all)
    assert.equal(plan.approved, 0)
    f.db.sourceEnabled(source.id, false)
    await assert.rejects(f.prep.approve(plan.token), /changed/)
    plan = await f.prep.preview(all)
    assert.equal(plan.eligible, 0)
    f.db.sourceEnabled(source.id, true)
    f.hashes.start()
    await f.hashes.wait()
    await copyFile(track.path, path.join(f.audio, 'copy.wav'))
    await f.scan()
    plan = await f.prep.preview(all)
    assert.equal(plan.eligible, 0)
    assert.equal(plan.approved, 0)
  } finally {
    await f.close()
  }
})
test('pause/resume and source boundaries keep failed or unchecked audio out of approvals', async () => {
  const f = await fixture()
  try {
    await populate(f)
    f.hashes.start()
    f.hashes.pause()
    await f.hashes.wait()
    assert.equal(f.hashes.state()?.status, 'paused')
    f.hashes.start()
    await f.hashes.wait()
    assert.equal(f.hashes.state()?.checked, 4)
    const source = f.db.sources()[0]!
    f.db.sourceEnabled(source.id, false)
    f.hashes.start()
    await f.hashes.wait()
    assert.equal(f.hashes.state()?.failed, 4)
    assert.equal((await f.prep.preview(all)).eligible, 0)
  } finally {
    await f.close()
  }
})
test('exact-path preparation is retained; multiple/conflicting rekordbox matches block export', async () => {
  const f = await fixture()
  try {
    const a = path.join(f.audio, 'reference.wav')
    await writeFile(a, wav({ genre: 'Pop', title: 'Reference', artist: 'Synthetic' }))
    f.db.addSource(f.audio)
    await f.scan()
    const row = f.db.db.prepare('SELECT * FROM files').get() as CatalogFile
    row.tags = JSON.parse(row.tags as unknown as string)
    row.category = 'Pop'
    const files = playlistFiles(
      [
        {
          track: row,
          reference: {
            attrs: JSON.stringify({
              Name: 'Reference',
              Artist: 'Synthetic',
              Genre: 'Pop',
              Rating: '204',
              Size: String(row.size),
              Location: a,
            }),
            tempo: JSON.stringify([{ Inizio: '0', Bpm: '128', Metro: '4/4', Battito: '1' }]),
            cues: JSON.stringify([{ Name: 'Intro', Type: '0', Start: '0.25', Num: '0' }]),
          },
        },
      ],
      'Synthetic imported folder',
      '7.synthetic'
    )
    const xmlFile = path.join(f.root, 'snapshot.xml')
    await writeFile(xmlFile, files['rekordbox.xml']!)
    const found = await f.rb.find([xmlFile])
    await f.rb.import(found.candidates[0]!.id)
    await f.classify()
    f.hashes.start()
    await f.hashes.wait()
    let plan = await f.prep.preview(all)
    assert.equal(plan.eligible, 1)
    assert.equal(plan.known, 1)
    await f.prep.approve(plan.token)
    plan = await f.prep.preview(all)
    const out = await f.prep.export(plan.token, f.root, 'test')
    const xml = await readFile(path.join(out.directory, 'rekordbox.xml'), 'utf8')
    assert.ok(xml.includes('Rating="204"'))
    assert.ok(xml.includes('Start="0.25"'))
    assert.ok(xml.includes('Bpm="128"'))
    f.db.db
      .prepare('UPDATE rb_matches SET conflicts=?')
      .run(
        JSON.stringify([
          'AverageBpm: XML 170 · catalog 85',
          'Genre: XML Pop Rock · embedded Pop / Rock',
          'Artist: XML X ft Y · embedded X / Y',
        ])
      )
    plan = await f.prep.preview(all)
    assert.equal(plan.eligible, 1)
    assert.equal(plan.needsApproval, 1, 'changed snapshot evidence needs fresh approval')
    assert.match(
      f.prep.page(plan.token, 0, 'eligible').items[0]!.notes.join(' '),
      /metadata differs/
    )
    await f.prep.approve(plan.token)
    plan = await f.prep.preview(all)
    const revised = await f.prep.export(plan.token, f.root, 'test')
    const revisedXML = await readFile(path.join(revised.directory, 'rekordbox.xml'), 'utf8')
    assert.ok(
      revisedXML.includes('Rating="204"') &&
        revisedXML.includes('Start="0.25"') &&
        revisedXML.includes('Bpm="128"')
    )
    f.db.db.prepare('UPDATE rb_matches SET conflicts=\'["Name: differs"]\'').run()
    assert.equal((await f.prep.preview(all)).eligible, 0)
    f.db.db
      .prepare("UPDATE rb_matches SET fileId=NULL,status='possible',candidates=?,conflicts='[]'")
      .run(JSON.stringify([row.id]))
    assert.equal((await f.prep.preview(all)).eligible, 0)
  } finally {
    await f.close()
  }
})
test('schema 4 upgrades keep the catalog and a private pre-upgrade backup', async () => {
  const dir = path.resolve('../../work/upgrade-preparation-' + randomUUID())
  const db = new LibraryDB(dir)
  db.addSource('/synthetic-only')
  db.db.exec(
    'DROP TABLE playlist_exports;DROP TABLE playlist_approvals;DROP TABLE duplicate_decisions;DROP TABLE duplicate_job;DROP TABLE file_hashes;PRAGMA user_version=4;'
  )
  db.close()
  const next = new LibraryDB(dir)
  try {
    assert.equal(next.db.pragma('user_version', { simple: true }), 8)
    assert.equal(next.sources().length, 1)
    const filename = (await readdir(dir)).find(n => n.startsWith('before-schema-5-'))!
    const backup = new Database(path.join(dir, filename), { readonly: true })
    assert.equal(backup.pragma('user_version', { simple: true }), 4)
    backup.close()
  } finally {
    next.close()
  }
})
test('preparation IPC rejects arbitrary export paths, forged decisions and XML-illegal text', () => {
  assert.equal(
    requestSchemas.preparationExport.safeParse({
      token: randomUUID(),
      parent: '/tmp',
    }).success,
    false
  )
  assert.equal(
    requestSchemas.duplicateResolve.safeParse({
      key: '../../anything',
      fingerprint: 'a'.repeat(64),
      keeper: null,
    }).success,
    false
  )
  assert.equal(
    requestSchemas.preparationPreview.safeParse({ scope: 'selected', ids: [] }).success,
    false
  )
  assert.equal(
    requestSchemas.preparationPreview.safeParse({
      scope: 'all',
      ids: [randomUUID()],
    }).success,
    false
  )
  assert.throws(() => escapeXML('illegal\u0001text'))
  assert.equal(escapeXML('🔥 & é'), '🔥 &amp; é')
})
test('50,000 prepared catalog rows produce bounded previews and paginated duplicate review', async () => {
  const f = await fixture()
  try {
    const source = f.db.addSource(f.audio)
    const now = new Date().toISOString()
    const insert = f.db.db.prepare(
      "INSERT INTO files(id,physicalKey,path,filename,sourceId,signature,artist,title,size,category,review,availability,addedAt,updatedAt,tags) VALUES(?,?,?,?,?,'synthetic','Synthetic',?,20,'Pop','Ready for Approval','available',?,?,'{}')"
    )
    const hash = f.db.db.prepare("INSERT INTO file_hashes VALUES(?,'synthetic',?,?,NULL,?)")
    const classified = f.db.db.prepare(
      "INSERT INTO classification_results VALUES(?,'synthetic','{}',?,NULL)"
    )
    f.db.db.transaction(() => {
      for (let i = 0; i < 50000; i++) {
        const id = randomUUID()
        insert.run(
          id,
          id,
          path.join(f.audio, `${i}.wav`),
          `${i}.wav`,
          source.id,
          `Track ${i}`,
          now,
          now
        )
        hash.run(id, id, sha(String(i)), now)
        classified.run(id, now)
      }
      f.db.db.prepare('DELETE FROM classification_queue').run()
    })()
    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    const started = performance.now()
    const plan = await f.prep.preview(all)
    const elapsed = performance.now() - started
    clearInterval(timer)
    assert.equal(plan.eligible, 50000)
    assert.equal(f.prep.page(plan.token, 0, 'eligible').items.length, 50)
    assert.equal(f.prep.page(plan.token, 49950, 'eligible').items.length, 50)
    assert.ok(ticks > 10)
    f.db.db.prepare('UPDATE file_hashes SET hash=?').run(sha('same full-file bytes'))
    const groups = await f.prep.duplicates(0)
    assert.equal(groups.groups[0]?.memberCount, 50000)
    assert.equal(groups.groups[0]?.members.length, 50)
    const more = await f.prep.duplicateMembers(
      groups.groups[0]!.key,
      groups.groups[0]!.fingerprint,
      50
    )
    assert.equal(more.length, 50)
    assert.notEqual(more[0]!.track.id, groups.groups[0]!.members[0]!.track.id)
    console.log(
      `Preparation benchmark: ${JSON.stringify({ records: 50000, previewMilliseconds: Math.round(elapsed), eventLoopTicks: ticks, pageLimit: 50, scope: 'Synthetic catalog metadata; not full-file hashing throughput' })}`
    )
  } finally {
    await f.close()
  }
})

test('tentative genres remain held while a known Reggaeton genre can export without an era', async () => {
  const f = await fixture()
  try {
    for (const [title, genre] of [
      ['Broad', 'Latin'],
      ['Cross', 'Hip-Hop / R&B'],
      ['Era', 'Reggaeton'],
    ])
      await writeFile(
        path.join(f.audio, title + '.wav'),
        wav({ title, genre, artist: 'Synthetic placement fixture' })
      )
    f.db.addSource(f.audio)
    await f.scan()
    f.hashes.start()
    await f.hashes.wait()
    assert.deepEqual(f.db.summary().categoryCounts, {
      'Hip Hop': 1,
      'Latin Other': 1,
      Reggaeton: 1,
    })
    const plan = await f.prep.preview(all)
    assert.equal(plan.eligible, 1)
    assert.equal(plan.reasons['Needs Review'], 1)
    assert.equal(plan.reasons['Conflicting Evidence'], 1)
    assert.equal(plan.categories.Reggaeton, 1)
    assert.equal(plan.needsApproval, 1)
    await assert.rejects(f.prep.export(plan.token, f.root, 'test'))
  } finally {
    await f.close()
  }
})

async function duplicateFixture() {
  const f = await fixture()
  await writeFile(
    path.join(f.audio, 'a.wav'),
    wav({ title: 'Synthetic Cleanup', artist: 'Generated Only', genre: 'Pop' })
  )
  await copyFile(path.join(f.audio, 'a.wav'), path.join(f.audio, 'b.wav'))
  f.db.addSource(f.audio)
  await f.scan()
  f.hashes.start()
  await f.hashes.wait()
  const cleanup = new DuplicateCleanup(f.db, f.helper, f.hashes, f.prep, () => {})
  return {
    ...f,
    cleanup,
    close: async () => {
      await cleanup.close()
      await f.close()
    },
  }
}
test('bulk copy choice prefers Rekordbox preparation and retains manual choices and distinct version labels', async () => {
  const f = await fixture()
  try {
    const paths = await populate(f)
    f.hashes.start()
    await f.hashes.wait()
    const g = (await f.prep.duplicates(0)).groups.find(g => g.kind === 'exact')!
    const preferred = g.members.find(m => m.track.path === paths.copy)!
    assert.equal(
      bestCopy(
        g.members.map(m => ({
          ...m,
          references: m === preferred ? 1 : 0,
          cues: m === preferred ? 8 : 0,
        }))
      ).track.id,
      preferred.track.id
    )
    await f.prep.resolve(g.key, g.fingerprint, preferred.track.id)
    const result = await f.prep.autoChoose()
    assert.equal(result.preservedChoices, 1)
    assert.equal(result.candidateGroups, 1)
    const after = await f.prep.duplicates(0)
    assert.equal(after.unresolved, 0)
    assert.equal(after.groups.find(g => g.kind === 'exact')?.keeper, preferred.track.id)
    assert.ok((await f.prep.preview(all)).total === 4)
    await access(paths.remix)
    assert.equal((await f.prep.autoChoose()).exactGroups, 0)
  } finally {
    await f.close()
  }
})
test('bulk copy choice preserves keep-all decisions and candidate keepers when exact groups collapse', async () => {
  const f = await fixture()
  try {
    const paths = await populate(f)
    f.hashes.start()
    await f.hashes.wait()
    const candidate = (await f.prep.duplicates(0)).groups.find(g => g.kind === 'candidate')!
    const chosen = candidate.members.find(m => m.track.path === paths.copy)!
    await f.prep.resolve(candidate.key, candidate.fingerprint, chosen.track.id)
    await f.prep.autoChoose()
    let groups = (await f.prep.duplicates(0)).groups
    assert.equal(groups.find(g => g.kind === 'exact')?.keeper, chosen.track.id)
    assert.equal(groups.find(g => g.kind === 'candidate')?.keeper, chosen.track.id)
    const exact = groups.find(g => g.kind === 'exact')!
    await f.prep.resolve(exact.key, exact.fingerprint, null)
    await f.prep.autoChoose()
    groups = (await f.prep.duplicates(0)).groups
    assert.equal(groups.find(g => g.kind === 'exact')?.keeper, null)
  } finally {
    await f.close()
  }
})
test('duplicate cleanup protects snapshot paths and saved exports, and rejects forged IPC', async () => {
  const f = await duplicateFixture()
  try {
    await f.prep.autoChoose()
    let plan = await f.cleanup.preview()
    assert.equal(plan.files, 1)
    const extra = plan.examples[0]!.path
    const snapshot = randomUUID()
    const now = new Date().toISOString()
    f.db.db
      .prepare(
        "INSERT INTO rb_snapshots VALUES(?, 'synthetic.xml',?,?,?,0,'rekordbox',1,0,0,0,'[]',?,0)"
      )
      .run(snapshot, now, now, 'test', now)
    f.db.db
      .prepare("INSERT INTO rb_tracks VALUES(?,'1','{}',?,'local','[]','[]')")
      .run(snapshot, extra)
    await assert.rejects(f.cleanup.start(plan.token), /changed/)
    plan = await f.cleanup.preview()
    assert.equal(plan.files, 0)
    assert.equal(plan.protected['Referenced by a Rekordbox snapshot or saved export'], 1)
    f.db.db.prepare('DELETE FROM rb_tracks WHERE snapshotId=?').run(snapshot)
    f.db.db
      .prepare('INSERT INTO playlist_exports VALUES(?,?,?)')
      .run(randomUUID(), '{}', JSON.stringify({ tracks: [{ path: extra }] }))
    assert.equal((await f.cleanup.preview()).files, 0)
    assert.equal(requestSchemas.cleanupStart.safeParse({ path: extra }).success, false)
    assert.equal(requestSchemas.cleanupRestore.safeParse('../../other').success, false)
    assert.equal(requestSchemas.duplicateAutoChoose.safeParse({ keeper: extra }).success, false)
  } finally {
    await f.close()
  }
})
test('native duplicate cleanup moves only verified extras to recoverable Trash and restores bytes and visibility', async () => {
  const f = await duplicateFixture()
  try {
    await f.prep.autoChoose()
    const plan = await f.cleanup.preview()
    assert.equal(plan.files, 1)
    const extra = plan.examples[0]!,
      bytes = await readFile(extra.path)
    await f.cleanup.start(plan.token)
    await f.cleanup.wait()
    assert.equal(f.cleanup.state()?.status, 'completed', JSON.stringify(f.cleanup.state()))
    assert.equal(f.cleanup.state()?.trashed, 1)
    await assert.rejects(access(extra.path))
    assert.deepEqual(await readFile(extra.keeper), bytes)
    assert.equal(f.db.summary().files, 1)
    assert.equal((await f.prep.preview(all)).total, 1)
    const id = f.cleanup.state()!.id
    const journal = JSON.parse(
      await readFile(path.join(f.db.directory, 'duplicate-cleanup', id + '.json'), 'utf8')
    )
    assert.deepEqual(await readFile(journal.entries[0].trashPath), bytes)
    await access(path.join(f.db.directory, journal.backup))
    await f.cleanup.restore(id)
    await f.cleanup.wait()
    assert.equal(f.cleanup.state()?.status, 'restored', JSON.stringify(f.cleanup.state()))
    assert.deepEqual(await readFile(extra.path), bytes)
    assert.equal(f.db.summary().files, 2)
  } finally {
    if ((f.cleanup.state()?.trashed || 0) > (f.cleanup.state()?.restored || 0)) {
      await f.cleanup.restore(f.cleanup.state()!.id)
      await f.cleanup.wait()
    }
    await f.close()
  }
})
test('cleanup refuses changed contents and stale source choices without touching the keeper', async () => {
  const f = await duplicateFixture()
  try {
    await f.prep.autoChoose()
    let plan = await f.cleanup.preview()
    const source = f.db.sources()[0]!
    f.db.sourceEnabled(source.id, false)
    await assert.rejects(f.cleanup.start(plan.token), /changed/)
    f.db.sourceEnabled(source.id, true)
    plan = await f.cleanup.preview()
    const extra = plan.examples[0]!
    await appendFile(extra.path, 'changed')
    await f.cleanup.start(plan.token)
    await f.cleanup.wait()
    assert.equal(f.cleanup.state()?.trashed, 0)
    assert.equal(f.cleanup.state()?.failed, 1)
    await access(extra.path)
    await access(extra.keeper)
  } finally {
    await f.close()
  }
})
test('native cleanup refuses hard links and symbolic links', async () => {
  const f = await duplicateFixture()
  try {
    const a = path.join(f.audio, 'a.wav'),
      hard = path.join(f.audio, 'hard.wav'),
      sym = path.join(f.audio, 'sym.wav')
    await link(a, hard)
    await symlink(a, sym)
    await assert.rejects(
      f.helper.call('trash', { path: a, expected: await f.helper.inspect(a) }),
      /hard link/
    )
    await assert.rejects(
      f.helper.call('trash', {
        path: sym,
        expected: await f.helper.inspect(sym),
      }),
      /symbolic link/
    )
    await access(a)
    await access(hard)
  } finally {
    await f.close()
  }
})
test('restore never overwrites a replacement file', async () => {
  const f = await duplicateFixture()
  let extra = ''
  try {
    await f.prep.autoChoose()
    const plan = await f.cleanup.preview()
    extra = plan.examples[0]!.path
    await f.cleanup.start(plan.token)
    await f.cleanup.wait()
    assert.equal(f.cleanup.state()?.trashed, 1)
    await writeFile(extra, 'replacement must survive')
    await f.cleanup.restore(f.cleanup.state()!.id)
    await f.cleanup.wait()
    assert.equal(await readFile(extra, 'utf8'), 'replacement must survive')
    assert.equal(f.cleanup.state()?.restored, 0)
  } finally {
    if (extra) await rm(extra, { force: true })
    if (f.cleanup.state()?.trashed && !f.cleanup.state()?.restored) {
      await f.cleanup.restore(f.cleanup.state()!.id)
      await f.cleanup.wait()
    }
    // Any uncertain native move still has a journaled recovery path.
    const id = f.cleanup.state()?.id
    if (id) {
      const file = path.join(f.db.directory, 'duplicate-cleanup', id + '.json')
      const j = JSON.parse(await readFile(file, 'utf8'))
      for (const e of j.entries)
        if (e.status === 'uncertain' && e.trashPath) {
          await f.helper.call('restore', {
            path: e.trashPath,
            destination: e.file.path,
            expected: await f.helper.inspect(e.trashPath),
          })
        }
    }
    await f.close()
  }
})

test('cleanup keeps remaining duplicate groups resolved without discarding the selected keeper', async () => {
  const f = await duplicateFixture()
  try {
    await copyFile(path.join(f.audio, 'a.wav'), path.join(f.audio, 'c.wav'))
    await f.scan()
    f.hashes.start()
    await f.hashes.wait()
    await f.prep.autoChoose()
    const selection = await f.prep.cleanupCandidates()
    assert.equal(selection.items.length, 2)
    const keeper = selection.items[0]!.keeper.id
    f.db.db
      .prepare("UPDATE files SET availability='trashed' WHERE id=?")
      .run(selection.items[0]!.file.id)
    await f.prep.reconcileCleanupChoices(selection.decisions)
    const groups = await f.prep.duplicates(0)
    assert.equal(groups.unresolved, 0)
    assert.equal(groups.groups[0]?.keeper, keeper)
  } finally {
    await f.close()
  }
})
test('an interrupted cleanup journal never repeats an uncertain file move automatically', async () => {
  const f = await duplicateFixture()
  try {
    const id = randomUUID(),
      dir = path.join(f.db.directory, 'duplicate-cleanup')
    const row = f.db.db.prepare('SELECT * FROM files LIMIT 1').get() as CatalogFile
    const state = {
      id,
      status: 'running',
      total: 1,
      trashed: 0,
      restored: 0,
      failed: 0,
      bytes: 0,
      current: 'test',
      error: null,
    }
    await writeFile(path.join(dir, 'latest'), id)
    await writeFile(
      path.join(dir, id + '.json'),
      JSON.stringify({
        version: 1,
        state,
        entries: [{ file: row, keeper: row, hash: 'test', status: 'moving' }],
        decisions: [],
        backup: 'synthetic',
      })
    )
    const resumed = new DuplicateCleanup(f.db, f.helper, f.hashes, f.prep, () => {})
    assert.equal(resumed.state()?.status, 'interrupted')
    await access(row.path)
    const journal = JSON.parse(await readFile(path.join(dir, id + '.json'), 'utf8'))
    assert.equal(journal.entries[0].status, 'uncertain')
    await resumed.close()
  } finally {
    await f.close()
  }
})

test('most collection references win before cues; playlist appearances break ties and explicit re-pick replaces saved choices', async () => {
  const f = await duplicateFixture()
  try {
    let g = (await f.prep.duplicates(0)).groups[0]!
    const [a, b] = g.members
    assert.ok(a && b)
    assert.equal(
      bestCopy([
        { ...a, references: 1, cues: 20 },
        { ...b, references: 2, cues: 0 },
      ]).track.id,
      b.track.id
    )
    assert.equal(
      bestCopy([
        { ...a, references: 1, playlistReferences: 1, cues: 20 },
        { ...b, references: 1, playlistReferences: 2, cues: 0 },
      ]).track.id,
      b.track.id
    )
    const snapshot = randomUUID(),
      now = new Date().toISOString()
    f.db.db
      .prepare(
        "INSERT INTO rb_snapshots VALUES(?,'synthetic.xml',?,?,?,0,'rekordbox',3,1,1,0,'[]',?,1)"
      )
      .run(snapshot, now, now, 'test', now)
    for (const [key, member] of [
      ['1', a],
      ['2', b],
      ['3', b],
    ] as const) {
      f.db.db
        .prepare("INSERT INTO rb_tracks VALUES(?,?,'{}',?,'local','[]','[]')")
        .run(snapshot, key, member.track.path)
      f.db.db
        .prepare("INSERT INTO rb_matches VALUES(?,?,'referenced','synthetic',?,'[]','[]')")
        .run(snapshot, key, member.track.id)
    }
    f.db.db.prepare("INSERT INTO rb_memberships VALUES(?,'playlist',0,'2','0','2')").run(snapshot)
    g = (await f.prep.duplicates(0)).groups[0]!
    assert.equal(g.members.find(m => m.track.id === b.track.id)?.playlistReferences, 1)
    await f.prep.resolve(g.key, g.fingerprint, a.track.id)
    await f.prep.autoChoose()
    assert.equal((await f.prep.duplicates(0)).groups[0]?.keeper, a.track.id)
    await f.prep.autoChoose(true)
    assert.equal((await f.prep.duplicates(0)).groups[0]?.keeper, b.track.id)
    assert.equal((await f.cleanup.preview()).files, 0)
    const plan = await f.cleanup.preview(true)
    assert.equal(plan.files, 1)
    assert.equal(plan.referencedExtras, 1)
    assert.equal(plan.includeReferenced, true)
    assert.equal(plan.examples[0]?.keeper, b.track.path)
    const src = f.db.sources()[0]!
    f.db.sourceEnabled(src.id, false)
    await assert.rejects(f.cleanup.start(plan.token), /changed/)
    assert.equal((await f.cleanup.preview(true)).files, 0)
    assert.equal(
      requestSchemas.cleanupPreview.safeParse({ includeReferenced: 'yes' }).success,
      false
    )
    assert.equal(
      requestSchemas.cleanupPreview.safeParse({
        includeReferenced: true,
        path: a.track.path,
      }).success,
      false
    )
    assert.equal(
      requestSchemas.duplicateAutoChoose.safeParse({ replaceExisting: true }).success,
      true
    )
  } finally {
    await f.close()
  }
})

test('referenced cleanup override is journaled and earlier batches remain restorable without replacing keepers', async () => {
  const f = await duplicateFixture()
  const ids: string[] = []
  try {
    await f.prep.autoChoose()
    const first = await f.cleanup.preview()
    await f.cleanup.start(first.token)
    await f.cleanup.wait()
    ids.push(f.cleanup.state()!.id)
    assert.equal(f.cleanup.state()?.trashed, 1)
    const a = path.join(f.audio, 'next-a.wav'),
      b = path.join(f.audio, 'next-b.wav')
    await writeFile(
      a,
      wav({
        title: 'Another synthetic batch',
        artist: 'Generated Only',
        genre: 'Pop',
        frequency: 700,
      })
    )
    await copyFile(a, b)
    await f.scan()
    f.hashes.start()
    await f.hashes.wait()
    await f.prep.autoChoose()
    const second = await f.cleanup.preview()
    assert.equal(second.files, 1)
    f.db.db
      .prepare('INSERT INTO playlist_exports VALUES(?,?,?)')
      .run(randomUUID(), '{}', JSON.stringify({ tracks: [{ path: second.examples[0]!.path }] }))
    assert.equal((await f.cleanup.preview()).files, 0)
    const override = await f.cleanup.preview(true)
    assert.equal(override.referencedExtras, 1)
    await f.cleanup.start(override.token)
    await f.cleanup.wait()
    ids.push(f.cleanup.state()!.id)
    assert.equal(f.cleanup.state()?.trashed, 1)
    const journal = JSON.parse(
      await readFile(path.join(f.db.directory, 'duplicate-cleanup', ids[1] + '.json'), 'utf8')
    )
    assert.equal(journal.includeReferenced, true)
    assert.equal(journal.referencedExtras, 1)
    assert.equal(f.cleanup.history().length, 2)
    await f.cleanup.restore(ids[0]!)
    await f.cleanup.wait()
    assert.equal(f.cleanup.state()?.status, 'restored')
    await access(first.examples[0]!.path)
    await assert.rejects(access(second.examples[0]!.path))
    await f.cleanup.restore(ids[1]!)
    await f.cleanup.wait()
    assert.equal(f.cleanup.state()?.status, 'restored')
    await access(second.examples[0]!.path)
    await access(second.examples[0]!.keeper)
    await assert.rejects(f.cleanup.restore('../../other'), /Invalid/)
  } finally {
    for (const id of ids) {
      const h = f.cleanup.history().find(h => h.id === id)
      if (h && h.trashed > h.restored) {
        await f.cleanup.restore(id)
        await f.cleanup.wait()
      }
    }
    await f.close()
  }
})

test('unconfirmed Reggaeton eras use general playlists, preserve choices and tags, and need fresh approval when confirmed', async () => {
  const f = await fixture()
  try {
    for (const title of ['Old choice', 'New choice', 'Unknown era', 'Confirmed era'])
      await writeFile(
        path.join(f.audio, title + '.wav'),
        wav({ title, genre: 'Reggaeton', artist: 'Generated only' })
      )
    f.db.addSource(f.audio)
    await f.scan()
    f.hashes.start()
    await f.hashes.wait()
    const tracks = f.db.db.prepare('SELECT * FROM files ORDER BY title').all() as CatalogFile[]
    const bytes = await Promise.all(tracks.map(async t => sha(await readFile(t.path))))
    for (const track of tracks.filter(t => t.title!.endsWith('choice')))
      f.db.updateDecision(
        [{ id: track.id, revision: track.revision }],
        'category',
        track.title === 'Old choice' ? 'Reggaeton Old' : 'Reggaeton New'
      )
    const confirmed = tracks.find(t => t.title === 'Confirmed era')!
    f.classifier.eraYear({
      id: confirmed.id,
      revision: confirmed.revision,
      year: 2004,
      kind: 'recording',
      note: 'Synthetic year confirmation',
    })
    await f.classify()
    let plan = await f.prep.preview(all)
    assert.deepEqual(plan.categories, { 'Reggaeton Old': 1, Reggaeton: 3 })
    assert.equal(plan.eligible, 4)
    assert.equal(plan.needsApproval, 4)
    assert.equal(
      f.db.get(tracks.find(t => t.title === 'Old choice')!.id)?.category,
      'Reggaeton Old'
    )
    await f.prep.approve(plan.token)
    plan = await f.prep.preview(all)
    const out = await f.prep.export(plan.token, f.root, 'test')
    const manifest = JSON.parse(await readFile(path.join(out.directory, 'manifest.json'), 'utf8'))
    assert.equal(manifest.tracks.filter((t: any) => t.category === 'Reggaeton').length, 3)
    assert.equal(
      (await readFile(path.join(out.directory, 'Reggaeton.m3u8'), 'utf8'))
        .split('\n')
        .filter(line => line.startsWith('/')).length,
      3
    )
    const xml = await readFile(path.join(out.directory, 'rekordbox.xml'), 'utf8')
    assert.ok(xml.includes('Name="Reggaeton" KeyType="0" Entries="3"'))
    let syncXML = ''
    const synced = await f.prep.sync(false, 'test', async (value, guard) => {
      guard()
      syncXML = value
    })
    assert.equal(synced.tracks, 4)
    assert.ok(syncXML.includes('Name="Reggaeton" KeyType="0" Entries="3"'))
    const old = f.db.get(tracks.find(t => t.title === 'Old choice')!.id)!
    f.classifier.eraYear({
      id: old.id,
      revision: old.revision,
      year: 2005,
      kind: 'recording',
      note: 'Synthetic',
    })
    await f.classify()
    plan = await f.prep.preview(all)
    assert.equal(plan.categories['Reggaeton Old'], 2)
    assert.equal(plan.needsApproval, 1)
    const mismatch = f.db.get(old.id)!
    f.db.updateDecision(
      [{ id: mismatch.id, revision: mismatch.revision }],
      'category',
      'Reggaeton New'
    )
    await f.classify()
    plan = await f.prep.preview(all)
    assert.equal(
      plan.reasons['Confirm recording/version year'],
      1,
      'confirmed contradictory eras still need review'
    )
    assert.deepEqual(await Promise.all(tracks.map(async t => sha(await readFile(t.path)))), bytes)
  } finally {
    await f.close()
  }
})

test('preparation category review is atomic, scoped, refreshes eligibility and preserves non-category holds', async () => {
  const f = await fixture()
  try {
    for (const [title, genre] of [
      ['Broad', 'Latin'],
      ['Cross', 'Hip-Hop / R&B'],
      ['Unknown', ''],
    ])
      await writeFile(
        path.join(f.audio, title + '.wav'),
        wav({ title, genre, artist: 'Generated review only' })
      )
    f.db.addSource(f.audio)
    await f.scan()
    f.hashes.start()
    await f.hashes.wait()
    f.classifier.automatic(false)
    let plan = await f.prep.preview(all)
    const allItems = f.prep.page(plan.token, 0, 'all').items
    assert.equal(f.prep.page(plan.token, 0, 'blocked', 'Needs Review').total, 1)
    const ids = allItems.map(i => i.id)
    const revisions = ids.map(id => f.db.get(id)!.revision)
    await assert.rejects(f.prep.classify(plan.token, ids, null), /Choose a performance category/)
    assert.deepEqual(
      ids.map(id => f.db.get(id)!.revision),
      revisions,
      'no partial saves when one item is unclassified'
    )
    await assert.rejects(
      f.prep.classify(plan.token, [ids[0]!, randomUUID()], 'Dance'),
      /outside this preview/
    )
    await assert.rejects(
      f.prep.classify(plan.token, [ids[0]!, ids[0]!], 'Dance'),
      /distinct tracks/
    )
    const ready = allItems.filter(i => i.category && !i.category.startsWith('_'))
    plan = await f.prep.classify(
      plan.token,
      ready.map(i => i.id),
      null
    )
    assert.equal(plan.eligible, 2)
    assert.equal(plan.needsApproval, 2)
    assert.equal(
      f.classifier.state().automatic,
      false,
      'explicit review does not enable automatic classification'
    )
    assert.equal(
      f.classifier.state().pending,
      0,
      'review settles its local evidence even with automatic processing paused'
    )
    const unknown = allItems.find(i => i.title === 'Unknown')!
    plan = await f.prep.classify(plan.token, [unknown.id], 'Jersey Club')
    assert.equal(plan.eligible, 3)
    assert.equal(f.db.get(unknown.id)!.category, 'Jersey Club')
    await f.prep.approve(plan.token)
    plan = await f.prep.preview(all)
    assert.equal(plan.approved, 3)
    plan = await f.prep.classify(plan.token, [unknown.id], 'Dance')
    assert.equal(plan.needsApproval, 1, 'changing a category invalidates playlist approval')
    const stale = plan.token
    const changed = f.db.get(unknown.id)!
    f.db.updateDecision([{ id: unknown.id, revision: changed.revision }], 'category', 'Pop')
    await assert.rejects(f.prep.classify(stale, ids, 'Dance'), /changed/)
    plan = await f.prep.preview({ scope: 'selected', ids: [unknown.id] })
    await assert.rejects(
      f.prep.classify(plan.token, [ready[0]!.id], 'Dance'),
      /outside this preview/
    )
    f.db.db.prepare("UPDATE files SET availability='missing' WHERE id=?").run(unknown.id)
    plan = await f.prep.preview(all)
    plan = await f.prep.classify(plan.token, [unknown.id], 'Dance')
    assert.equal(plan.reasons['File unavailable'], 1, 'category saves never bypass file health')
    assert.equal(plan.eligible, 2)
  } finally {
    await f.close()
  }
})

test('preparation review IPC restricts category, scope, counts and unexpected fields', () => {
  const valid = { token: randomUUID(), ids: [randomUUID()], category: 'Pop' }
  assert.equal(requestSchemas.preparationClassify.safeParse(valid).success, true)
  for (const change of [
    { category: '_JUNK' },
    { category: 'arbitrary' },
    { ids: [] },
    { ids: [valid.ids[0], valid.ids[0]] },
    { ids: Array.from({ length: 1001 }, () => randomUUID()) },
    { path: '/tmp/arbitrary' },
  ])
    assert.equal(
      requestSchemas.preparationClassify.safeParse({ ...valid, ...change }).success,
      false
    )
})

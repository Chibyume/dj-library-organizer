import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, symlink } from 'node:fs/promises'
import path from 'node:path'
import { LibraryDB } from '../src/db'
import { Classifier } from '../src/classifier'
import { Researcher } from '../src/research'
import { ResearchImporter, researchBundleSchema } from '../src/research-import'
import { researchInput, inputDigest } from '../src/research-identity'
import { requestSchemas, type Track } from '../src/shared'

async function fixture() {
  const dir = await mkdtemp(path.resolve('../../work/import-research-test-'))
  const db = new LibraryDB(path.join(dir, 'profile'))
  const source = db.addSource(path.join(dir, 'synthetic'))
  const classifier = new Classifier(db, () => {})
  classifier.automatic(false)
  const importer = new ResearchImporter(db, classifier, () => {})
  const add = () => {
    const id = randomUUID(),
      now = new Date().toISOString()
    db.db
      .prepare(
        "INSERT INTO files(id,physicalKey,path,filename,sourceId,signature,title,artist,duration,size,availability,addedAt,updatedAt) VALUES(?,?,?,?,?,'synthetic-v1','Synthetic Title','Synthetic Artist',180,1024,'available',?,?)"
      )
      .run(id, id, path.join(source.path, id + '.wav'), id + '.wav', source.id, now, now)
    db.db
      .prepare('INSERT INTO locations(fileId,sourceId,path,available) VALUES(?,?,?,1)')
      .run(id, source.id, path.join(source.path, id + '.wav'))
    return db.get(id)!
  }
  const bundle = (...tracks: Track[]) => ({
    format: 'dj-library-research-v1',
    id: randomUUID(),
    label: 'Synthetic import fixture',
    createdAt: new Date().toISOString(),
    entries: tracks.map(t => ({
      fileId: t.id,
      signature: 'synthetic-v1',
      inputHash: inputDigest(researchInput(t)),
      candidate: {
        title: 'Synthetic Title',
        artist: 'Synthetic Artist',
        version: '',
        sameVersion: true,
        genre: 'Reggaeton',
        year: 2006,
        date: '2006-03',
        yearKind: 'recording',
        genreSources: ['https://musicbrainz.org/recording/' + t.id],
        yearSources: ['https://musicbrainz.org/recording/' + t.id],
        sources: [
          {
            url: 'https://musicbrainz.org/recording/' + t.id,
            title: 'Synthetic source; not real research',
          },
        ],
        reasons: ['Synthetic exact-version fixture'],
        category: null,
      },
    })),
  })
  return {
    dir,
    db,
    classifier,
    importer,
    add,
    bundle,
    close: async () => {
      await classifier.close()
      db.close()
    },
  }
}
test('research import applies a cited batch, journals provenance, feeds classification and survives provider retirement', async () => {
  const f = await fixture()
  try {
    const t = f.add(),
      b = f.bundle(t),
      p = f.importer.preview(b)
    assert.equal(p.eligible, 1)
    assert.deepEqual(f.importer.apply(p.token), { imported: 1 })
    const saved = f.db.db
      .prepare('SELECT value FROM research_approved WHERE fileId=?')
      .get(t.id) as { value: string }
    assert.equal(JSON.parse(saved.value).bundleId, b.id)
    assert.equal(f.db.get(t.id)?.year, null)
    assert.equal(f.db.get(t.id)?.genre, null)
    f.classifier.runNow()
    await f.classifier.wait()
    assert.equal(f.db.get(t.id)?.category, 'Reggaeton Old')
    const r = new Researcher(f.db, f.classifier, () => {})
    assert.equal(r.track(t.id).approved?.current, true)
    const source = b.entries[0]!.candidate.sources[0]!.url
    assert.equal(r.source({ id: t.id, resultId: b.id, url: source }), source)
    assert.throws(() => r.source({ id: t.id, resultId: randomUUID(), url: source }))
    assert.throws(() =>
      r.source({
        id: t.id,
        resultId: b.id,
        url: 'https://example.org/not-cited',
      })
    )
    assert.equal(f.importer.preview(b).held['Already imported'], 1)
    await r.close()
  } finally {
    await f.close()
  }
})
test('research import holds manual choices, disabled sources, old identity and saved research', async () => {
  const f = await fixture()
  try {
    const a = f.add(),
      b = f.add(),
      c = f.add()
    const bundle = f.bundle(a, b, c)
    f.db.db.prepare('UPDATE files SET manual=1 WHERE id=?').run(a.id)
    f.db.db.prepare("UPDATE files SET title='Changed' WHERE id=?").run(b.id)
    f.db.db
      .prepare('INSERT INTO research_approved VALUES(?,?,?,?,?)')
      .run(
        c.id,
        'synthetic-v1',
        inputDigest(researchInput(c)),
        JSON.stringify({ bundleId: randomUUID() }),
        new Date().toISOString()
      )
    const p = f.importer.preview(bundle)
    assert.equal(p.eligible, 0)
    assert.equal(p.held['Existing manual decision preserved'], 1)
    assert.equal(p.held['Track metadata changed since research'], 1)
    assert.equal(p.held['Saved research choice preserved'], 1)
  } finally {
    await f.close()
  }
})
test('research import revalidates atomically and refuses reused or forged preview tokens', async () => {
  const f = await fixture()
  try {
    const a = f.add(),
      b = f.add(),
      p = f.importer.preview(f.bundle(a, b))
    f.db.db.prepare('UPDATE files SET manual=1 WHERE id=?').run(b.id)
    assert.throws(() => f.importer.apply(p.token), /library changed/)
    assert.equal(
      (
        f.db.db.prepare('SELECT COUNT(*) n FROM research_approved').get() as {
          n: number
        }
      ).n,
      0
    )
    assert.throws(() => f.importer.apply(randomUUID()), /Preview/)
    f.db.db.prepare('UPDATE files SET manual=0 WHERE id=?').run(b.id)
    f.importer.apply(p.token)
    assert.throws(() => f.importer.apply(p.token), /Preview/)
  } finally {
    await f.close()
  }
})
test('research import rejects unverified versions, uncited values, inconsistent dates, duplicate IDs and path IPC', async () => {
  const f = await fixture()
  try {
    const b = f.bundle(f.add())
    for (const mutate of [
      (v: any) => (v.entries[0].candidate.sameVersion = false),
      (v: any) => (v.entries[0].candidate.yearSources = []),
      (v: any) => (v.entries[0].candidate.genreSources = ['https://example.org/unlisted']),
      (v: any) => (v.entries[0].candidate.date = '2008-01-01'),
      (v: any) => (v.entries[0].candidate.sources[0].url = 'file:///etc/passwd'),
      (v: any) => v.entries.push(v.entries[0]),
      (v: any) => (v.entries[0].path = '/Users/Synthetic/secret.wav'),
    ]) {
      const v = structuredClone(b)
      mutate(v)
      assert.equal(researchBundleSchema.safeParse(v).success, false)
    }
    assert.equal(requestSchemas.researchImportChoose.safeParse('/tmp/file.json').success, false)
    assert.equal(requestSchemas.researchImportApply.safeParse('/tmp/file.json').success, false)
  } finally {
    await f.close()
  }
})
test('research import reads selected local JSON and rejects symbolic links and conflicting saved era years', async () => {
  const f = await fixture()
  try {
    const t = f.add(),
      b = f.bundle(t),
      file = path.join(f.dir, 'research.json')
    await writeFile(file, JSON.stringify(b))
    assert.equal((await f.importer.choose(file)).eligible, 1)
    const link = path.join(f.dir, 'alias.json')
    await symlink(file, link)
    await assert.rejects(f.importer.choose(link))
    f.classifier.eraYear({
      id: t.id,
      revision: t.revision,
      year: 2007,
      kind: 'recording',
      note: 'Synthetic saved choice',
    })
    assert.equal(f.importer.preview(b).held['Saved era year needs review'], 1)
  } finally {
    await f.close()
  }
})

test('research import preserves observed availability after incomplete scans but holds busy, offline and disabled sources', async () => {
  const f = await fixture()
  try {
    const t = f.add(),
      b = f.bundle(t)
    for (const status of ['ready', 'partial', 'cancelled', 'interrupted']) {
      f.db.db.prepare('UPDATE sources SET status=?').run(status)
      assert.equal(f.importer.preview(b).eligible, 1)
    }
    for (const status of ['scanning', 'unavailable', 'failed']) {
      f.db.db.prepare('UPDATE sources SET status=?').run(status)
      assert.equal(f.importer.preview(b).eligible, 0)
    }
    f.db.db.prepare("UPDATE sources SET status='cancelled',enabled=0").run()
    assert.equal(f.importer.preview(b).eligible, 0)
    f.db.db.prepare('UPDATE sources SET enabled=1').run()
    f.db.db.prepare('UPDATE locations SET available=0').run()
    assert.equal(f.importer.preview(b).eligible, 0)
    f.db.db.prepare('UPDATE locations SET available=1').run()
    f.db.db.prepare("UPDATE files SET signature='new-version' WHERE id=?").run(t.id)
    assert.equal(f.importer.preview(b).held['Track metadata changed since research'], 1)
  } finally {
    await f.close()
  }
})

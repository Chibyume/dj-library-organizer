import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LibraryDB } from '../src/db'
import { Classifier } from '../src/classifier'
import { propose, type ClassificationInput } from '../src/classification'
import { Preparation } from '../src/preparation'
import type { NativeHelper } from '../src/native'
import type { DuplicateHashes } from '../src/duplicate-hashes'
import type { Category, ClassificationProposal, ClassificationEvidence } from '../src/shared'

const all = { scope: 'all' as const, ids: [] }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

async function fixture(genre = 'Pop', manualCategory?: Category) {
  const root = await mkdtemp(path.join(tmpdir(), 'dj-classifier-compat-synthetic-'))
  const db = new LibraryDB(path.join(root, 'profile'))
  const source = db.addSource(path.join(root, 'synthetic-audio'))
  const id = randomUUID(),
    signature = 'synthetic-signature',
    now = new Date().toISOString()
  db.register(
    {
      id,
      physicalKey: id,
      signature,
      path: path.join(source.path, 'Synthetic.wav'),
      filename: 'Synthetic.wav',
      sourceId: source.id,
      artist: 'Synthetic Artist',
      title: 'Synthetic Song',
      bpm: 100,
      year: 2020,
      genre,
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
    },
    'synthetic-scan'
  )
  // A complete revision-3 input fixture, including field order used in its digest.
  const input: ClassificationInput = {
    research: undefined,
    signature,
    filename: 'Synthetic.wav',
    title: 'Synthetic Song',
    genre,
    genres: [],
    year: 2020,
    originalYear: null,
    originalDate: null,
    availability: 'available',
    partial: false,
    xml: [],
    xmlOverflow: false,
    playlists: [],
    era: null,
  }
  const legacyHash = digest({ engine: 3, input, rules: [] })
  const legacy: ClassificationProposal = structuredClone(propose(input))
  if (genre === 'Salsa') {
    // Revision 3 grouped explicit Salsa metadata into Latin Other.
    legacy.category = 'Latin Other'
    legacy.candidates = ['Latin Other']
    legacy.evidence = legacy.evidence.map(entry =>
      entry.meaning === 'Maps to Salsa' ? { ...entry, meaning: 'Maps to Latin Other' } : entry
    )
  }
  db.db
    .prepare('UPDATE files SET category=?,review=? WHERE id=?')
    .run(legacy.category, legacy.status, id)
  if (manualCategory)
    db.updateDecision([{ id, revision: db.get(id)!.revision }], 'category', manualCategory)
  const evidence: ClassificationEvidence = {
    ...legacy,
    fileId: id,
    computedAt: now,
    manualConflict: false,
    stale: false,
    era: null,
  }
  db.db
    .prepare(
      'INSERT INTO classification_results(fileId,inputHash,result,computedAt,acknowledgedHash) VALUES(?,?,?,?,?)'
    )
    .run(id, legacyHash, JSON.stringify(evidence), now, manualCategory ? legacyHash : null)
  db.db.prepare('DELETE FROM classification_queue WHERE fileId=?').run(id)
  db.db
    .prepare('INSERT INTO file_hashes VALUES(?,?,?,?,NULL,?)')
    .run(id, signature, id, 'synthetic-byte-hash', now)
  const prep = new Preparation(
    db,
    {} as NativeHelper,
    { running: false, state: () => null } as unknown as DuplicateHashes,
    () => {}
  )
  const classifier = new Classifier(db, () => {})
  const before = await prep.preview(all)
  assert.equal(before.eligible, 1)
  await prep.approve(before.token)
  assert.equal((await prep.preview(all)).approved, 1)
  return {
    db,
    id,
    legacyHash,
    prep,
    classifier,
    input,
    close: async () => {
      await classifier.close()
      await prep.close()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('revision 3 approvals survive revision 4 startup when complete evidence and semantic proposal are unchanged', async () => {
  const f = await fixture()
  try {
    const revision = f.db.get(f.id)!.revision
    const approval = f.db.db
      .prepare('SELECT fingerprint FROM playlist_approvals WHERE fileId=?')
      .get(f.id)
    assert.equal(f.classifier.track(f.id)!.stale, false)
    f.classifier.runNow()
    await f.classifier.wait()
    assert.equal(f.classifier.state().lastJob!.status, 'completed')
    assert.equal(f.classifier.state().lastJob!.cached, 1)
    assert.equal(f.db.get(f.id)!.revision, revision)
    assert.equal(
      (
        f.db.db
          .prepare('SELECT inputHash FROM classification_results WHERE fileId=?')
          .get(f.id) as { inputHash: string }
      ).inputHash,
      f.legacyHash
    )
    assert.deepEqual(
      f.db.db.prepare('SELECT fingerprint FROM playlist_approvals WHERE fileId=?').get(f.id),
      approval
    )
    assert.equal((await f.prep.preview(all)).approved, 1)
    assert.equal(f.classifier.track(f.id)!.stale, false)
    f.classifier.runNow()
    await f.classifier.wait()
    assert.equal((await f.prep.preview(all)).approved, 1)
  } finally {
    await f.close()
  }
})

test('revision 4 named-genre changes replace legacy proposals and require fresh playlist approval', async () => {
  const f = await fixture('Salsa')
  try {
    assert.equal(f.db.get(f.id)!.category, 'Latin Other')
    assert.equal(f.classifier.track(f.id)!.stale, true)
    f.classifier.runNow()
    await f.classifier.wait()
    assert.equal(f.db.get(f.id)!.category, 'Salsa')
    assert.equal(
      (
        f.db.db
          .prepare('SELECT inputHash FROM classification_results WHERE fileId=?')
          .get(f.id) as { inputHash: string }
      ).inputHash,
      digest({ engine: 4, input: f.input, rules: [] })
    )
    const preview = await f.prep.preview(all)
    assert.equal(preview.eligible, 1)
    assert.equal(preview.approved, 0)
    assert.equal(preview.needsApproval, 1)
    assert.equal(f.classifier.track(f.id)!.stale, false)
  } finally {
    await f.close()
  }
})

test('legacy compatibility retains acknowledged manual choices without introducing a new conflict', async () => {
  const f = await fixture('Pop', 'Hip Hop')
  try {
    const revision = f.db.get(f.id)!.revision
    f.classifier.runNow()
    await f.classifier.wait()
    const saved = f.db.db
      .prepare('SELECT inputHash,acknowledgedHash FROM classification_results WHERE fileId=?')
      .get(f.id)
    assert.deepEqual(saved, {
      inputHash: f.legacyHash,
      acknowledgedHash: f.legacyHash,
    })
    assert.equal(f.db.get(f.id)!.category, 'Hip Hop')
    assert.equal(f.db.get(f.id)!.revision, revision)
    assert.equal(f.classifier.track(f.id)!.manualConflict, false)
    assert.equal((await f.prep.preview(all)).approved, 1)
  } finally {
    await f.close()
  }
})

test('changed input or saved rules never inherit legacy approvals even when the resulting genre stays the same', async () => {
  for (const change of ['input', 'rules'] as const) {
    const f = await fixture()
    try {
      if (change === 'input')
        f.db.db.prepare("UPDATE files SET title='Different synthetic title' WHERE id=?").run(f.id)
      else
        f.db.db
          .prepare('INSERT INTO classification_rules VALUES(?,?,?,?,?)')
          .run(
            randomUUID(),
            'versionLabel',
            'no matching title',
            'Bachata',
            new Date().toISOString()
          )
      assert.equal(f.classifier.track(f.id)!.stale, true)
      f.classifier.runNow()
      await f.classifier.wait()
      assert.equal(f.db.get(f.id)!.category, 'Pop')
      assert.notEqual(
        (
          f.db.db
            .prepare('SELECT inputHash FROM classification_results WHERE fileId=?')
            .get(f.id) as { inputHash: string }
        ).inputHash,
        f.legacyHash
      )
      const preview = await f.prep.preview(all)
      assert.equal(preview.eligible, 1)
      assert.equal(preview.approved, 0)
      assert.equal(preview.needsApproval, 1)
    } finally {
      await f.close()
    }
  }
})

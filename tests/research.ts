import { removeRetiredResearchKey } from '../src/research-retirement'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, writeFile, symlink } from 'node:fs/promises'
import path from 'node:path'
import { researchFailure, failureMessage } from '../src/research-failure'
import Database from 'better-sqlite3'
import { LibraryDB } from '../src/db'
import { Classifier } from '../src/classifier'
import { Researcher, researchInput } from '../src/research'
import {
  MusicBrainzAdapter,
  publicSource,
  boundedFetch,
  ProviderFailure,
  categoryFor,
  yearOf,
  type ResearchAdapter,
} from '../src/research-provider'
import {
  requestSchemas,
  type ResearchInput,
  type ResearchResult,
  type ResearchCandidate,
} from '../src/shared'
const input: ResearchInput = {
  title: 'Synthetic Harbor',
  artist: 'Fixture Artist',
  version: '',
  duration: 180,
  taggedYear: 2024,
  taggedGenre: null,
}
const url = 'https://musicbrainz.org/recording/' + randomUUID()
const c = (overrides: Partial<ResearchCandidate> = {}): ResearchCandidate => ({
  title: input.title,
  artist: input.artist,
  version: '',
  sameVersion: true,
  genre: 'Reggaeton',
  year: 2007,
  date: '2007-05',
  yearKind: 'recording',
  genreSources: [url],
  yearSources: [url],
  sources: [{ url, title: 'Synthetic provider fixture' }],
  reasons: ['Synthetic test response, not real-world music evidence'],
  category: 'Reggaeton Old',
  ...overrides,
})
const result = (provider: 'musicbrainz' = 'musicbrainz', candidate = c()): ResearchResult => ({
  id: randomUUID(),
  provider,
  model: null,
  retrievedAt: new Date().toISOString(),
  candidates: [candidate],
  notes: [],
})
async function fixture() {
  const directory = await mkdtemp(path.resolve(process.cwd(), '../../work/research-test-'))
  const db = new LibraryDB(path.join(directory, 'profile'))
  const source = db.addSource(path.join(directory, 'synthetic-library'))
  const classifier = new Classifier(db, () => {})
  function add(overrides: Partial<ResearchInput> = {}) {
    const data = { ...input, ...overrides }
    const id = randomUUID(),
      now = new Date().toISOString()
    const file = path.join(source.path, id + '.wav')
    db.db
      .prepare(
        "INSERT INTO files(id,physicalKey,path,filename,sourceId,signature,title,artist,duration,year,genre,size,availability,addedAt,updatedAt) VALUES(?,?,?,?,?,'fixture',?,?,?,?,?,1024,'available',?,?)"
      )
      .run(
        id,
        id,
        file,
        id + '.wav',
        source.id,
        data.title,
        data.artist,
        data.duration,
        data.taggedYear,
        data.taggedGenre,
        now,
        now
      )
    db.db
      .prepare('INSERT INTO locations(fileId,sourceId,path,available) VALUES(?,?,?,1)')
      .run(id, source.id, file)
    return db.get(id)!
  }
  const close = async (r?: Researcher) => {
    await r?.close()
    await classifier.close()
    db.close()
  }
  return { directory, db, classifier, source, add, close }
}
const plan = (r: Researcher, ids: string[], provider: 'musicbrainz' = 'musicbrainz') =>
  r.preview({ provider, scope: 'selected', ids, limit: 50 })

test('online research shares only bounded tag metadata, rejects paths and validates strict IPC', async () => {
  const f = await fixture()
  try {
    const t = f.add()
    const shared = researchInput(t)!
    assert.deepEqual(Object.keys(shared), [
      'title',
      'artist',
      'version',
      'duration',
      'taggedYear',
      'taggedGenre',
    ])
    assert.ok(!JSON.stringify(shared).includes(f.directory))
    assert.equal(researchInput({ ...t, title: '/Users/synthetic/Music/private.wav' }), null)
    assert.equal(researchInput({ ...t, title: null }), null)
    assert.equal(researchInput({ ...t, genre: '/Volumes/Fixture Disk/private' })?.taggedGenre, null)
    assert.equal(researchInput({ ...t, artist: '../private/artist' }), null)
    assert.equal(
      requestSchemas.researchPreview.safeParse({
        provider: 'musicbrainz',
        scope: 'selected',
        ids: Array(51).fill(t.id),
        limit: 50,
      }).success,
      false
    )
    assert.equal(
      requestSchemas.researchPreview.safeParse({
        provider: 'openai',
        scope: 'selected',
        ids: [t.id],
        limit: 1,
      }).success,
      false
    )
    assert.equal('researchKey' in requestSchemas, false)
    assert.equal(publicSource('file:///generated/private.wav'), false)
    assert.equal(publicSource('https://127.0.0.1/'), false)
    assert.equal(publicSource('https://localhost.local/'), false)
    assert.equal(publicSource(url), true)
  } finally {
    await f.close()
  }
})

test('MusicBrainz adapter ranks identity, checks duration/version, gets community genres, throttles and limits retries', async () => {
  const id = randomUUID()
  const rec = {
    id,
    title: input.title,
    'artist-credit': [{ name: input.artist, artist: { name: input.artist } }],
    length: 180000,
    'first-release-date': '2007-05',
    genres: [{ name: 'reggaeton', count: 5 }],
  }
  let requests = 0
  const starts: number[] = []
  const fetcher = (async (u, init) => {
    starts.push(Date.now())
    requests++
    assert.match(String(u), /^https:\/\/musicbrainz.org\/ws\/2\/recording\//)
    assert.match(new Headers(init?.headers).get('user-agent')!, /DJLibraryOrganizer/)
    return Response.json(String(u).includes('query=') ? { recordings: [rec] } : rec)
  }) as typeof fetch
  const adapter = new MusicBrainzAdapter(fetcher, 25)
  const found = await adapter.lookup(input, new AbortController().signal)
  assert.equal(requests, 2)
  assert.ok(starts[1]! - starts[0]! >= 20)
  assert.equal(found.candidates[0]!.sameVersion, true)
  assert.equal(found.candidates[0]!.category, 'Reggaeton Old')
  const different = await adapter.lookup({ ...input, duration: 240 }, new AbortController().signal)
  assert.equal(different.candidates[0]!.sameVersion, false)
  let retries = 0
  const unavailable = new MusicBrainzAdapter(
    (async () => {
      retries++
      return new Response('', { status: 503, headers: { 'retry-after': '0' } })
    }) as typeof fetch,
    1
  )
  await assert.rejects(unavailable.lookup(input, new AbortController().signal), ProviderFailure)
  assert.equal(retries, 3)
})

test('network responses are bounded and redirects, oversized bodies, failures and cancellation are rejected', async () => {
  await assert.rejects(
    boundedFetch(
      'https://musicbrainz.org/ws/2/',
      {},
      (async () => new Response(new Uint8Array(3 * 1024 * 1024 + 1))) as typeof fetch
    ),
    ProviderFailure
  )
  const abort = new AbortController()
  const pending = new MusicBrainzAdapter(
    (async (_u, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')))
      })) as typeof fetch,
    1
  ).lookup(input, abort.signal)
  await new Promise(r => setTimeout(r, 10))
  abort.abort()
  await assert.rejects(pending)
})

test('research preview performs no network, approval feeds classification while tags and manual decisions persist', async () => {
  const f = await fixture()
  let requests = 0
  const mock: ResearchAdapter = {
    lookup: async () => {
      requests++
      return result()
    },
  }
  const r = new Researcher(f.db, f.classifier, () => {}, {
    musicbrainz: mock,
  })
  try {
    const t = f.add()
    f.classifier.schedule()
    await f.classifier.wait()
    const p = plan(r, [t.id])
    assert.equal(requests, 0)
    r.start(p.token)
    await r.wait()
    assert.equal(requests, 1)
    assert.equal(f.db.get(t.id)?.category, null)
    const ev = r.track(t.id)
    const current = f.db.get(t.id)!
    r.accept({
      id: t.id,
      revision: current.revision,
      resultId: ev.result!.id,
      candidate: 0,
    })
    await f.classifier.wait()
    let updated = f.db.get(t.id)!
    assert.equal(updated.category, 'Reggaeton Old')
    assert.equal(updated.year, 2024)
    assert.equal(updated.genre, null)
    assert.equal(updated.manual, false)
    assert.equal(r.track(t.id).approved?.current, true)
    assert.throws(
      () =>
        r.accept({
          id: t.id,
          revision: updated.revision,
          resultId: ev.result!.id,
          candidate: 0,
        }),
      /Clear/
    )
    f.db.updateDecision([{ id: t.id, revision: updated.revision }], 'category', 'Jersey Club')
    f.classifier.schedule()
    await f.classifier.wait()
    updated = f.db.get(t.id)!
    assert.equal(updated.category, 'Jersey Club')
    assert.equal(updated.manual, true)
    r.clear({ id: t.id, revision: updated.revision })
    await f.classifier.wait()
    assert.equal(f.db.get(t.id)?.category, 'Jersey Club')
    assert.equal(r.track(t.id).approved, null)
  } finally {
    await f.close(r)
  }
})

test('research cache survives restart, avoids duplicate calls for copies and stale results cannot be approved', async () => {
  const f = await fixture()
  let calls = 0
  const mock: ResearchAdapter = {
    lookup: async () => {
      calls++
      return result()
    },
  }
  let r = new Researcher(f.db, f.classifier, () => {}, {
    musicbrainz: mock,
  })
  try {
    const a = f.add(),
      b = f.add()
    r.start(plan(r, [a.id, b.id]).token)
    await r.wait()
    assert.equal(calls, 1)
    assert.equal(r.state().job?.cached, 1)
    await r.close()
    r = new Researcher(f.db, f.classifier, () => {}, {
      musicbrainz: mock,
    })
    const p = plan(r, [a.id])
    assert.equal(p.networkTracks, 0)
    r.start(p.token)
    await r.wait()
    assert.equal(calls, 1)
    const ev = r.track(a.id)
    f.db.db
      .prepare("UPDATE files SET signature='different',revision=revision+1 WHERE id=?")
      .run(a.id)
    assert.equal(r.track(a.id).stale, true)
    assert.throws(
      () =>
        r.accept({
          id: a.id,
          revision: f.db.get(a.id)!.revision,
          resultId: ev.result!.id,
          candidate: 0,
        }),
      /current/
    )
  } finally {
    await f.close(r)
  }
})

test('source pause and metadata changes invalidate previews and discard in-flight results', async () => {
  const f = await fixture()
  let resolve!: (r: ResearchResult) => void
  const mock: ResearchAdapter = {
    lookup: () =>
      new Promise(r => {
        resolve = r
      }),
  }
  const r = new Researcher(f.db, f.classifier, () => {}, {
    musicbrainz: mock,
  })
  try {
    const t = f.add()
    const p = plan(r, [t.id])
    f.db.sourceEnabled(f.source.id, false)
    assert.throws(() => r.start(p.token), /access changed/)
    f.db.sourceEnabled(f.source.id, true)
    r.start(plan(r, [t.id]).token)
    await new Promise<void>(r => setImmediate(r))
    f.db.db.prepare("UPDATE files SET title='Changed title' WHERE id=?").run(t.id)
    resolve(result())
    await r.wait()
    assert.equal(r.track(t.id).result, null)
    assert.equal(r.state().job?.skipped, 1)
  } finally {
    await f.close(r)
  }
})

test('paused/interrupted network requests are never retried automatically and the remaining queue resumes explicitly', async () => {
  const f = await fixture()
  let calls = 0
  const mock: ResearchAdapter = {
    lookup: async (_i, s) => {
      calls++
      return new Promise((_resolve, reject) =>
        s.addEventListener('abort', () => reject(new Error('synthetic private provider error')))
      )
    },
  }
  let r = new Researcher(f.db, f.classifier, () => {}, {
    musicbrainz: mock,
  })
  try {
    const a = f.add(),
      b = f.add({ title: 'Other synthetic song' })
    r.start(plan(r, [a.id, b.id], 'musicbrainz').token)
    await new Promise<void>(r => setImmediate(r))
    r.pause()
    await r.wait()
    assert.equal(calls, 1)
    assert.equal(r.state().job?.status, 'paused')
    assert.equal(r.state().pending, 1)
    assert.ok(!r.state().job!.message.includes('private provider error'))
    await r.close()
    const good: ResearchAdapter = {
      lookup: async () => result('musicbrainz', c({ title: 'Other synthetic song' })),
    }
    r = new Researcher(f.db, f.classifier, () => {}, {
      musicbrainz: good,
    })
    assert.equal(r.state().pending, 1)
    const p = r.preview({
      provider: 'musicbrainz',
      scope: 'pending',
      ids: [],
      limit: 50,
    })
    assert.equal(p.tracks.length, 1)
    assert.equal(p.tracks[0]!.id, b.id)
    r.start(p.token)
    await r.wait()
    assert.equal(r.state().pending, 0)
    assert.equal(r.state().job?.completed, 1)
  } finally {
    await f.close(r)
  }
})

test('research source links are restricted to stored evidence, and saved era decisions require explicit replacement', async () => {
  const f = await fixture()
  const mock: ResearchAdapter = { lookup: async () => result() }
  const r = new Researcher(f.db, f.classifier, () => {}, {
    musicbrainz: mock,
  })
  try {
    let t = f.add()
    r.start(plan(r, [t.id]).token)
    await r.wait()
    const ev = r.track(t.id)
    assert.equal(r.source({ id: t.id, resultId: ev.result!.id, url }), url)
    assert.throws(
      () =>
        r.source({
          id: t.id,
          resultId: ev.result!.id,
          url: 'https://musicbrainz.org/unrelated',
        }),
      /not part/
    )
    f.classifier.eraYear({
      id: t.id,
      revision: t.revision,
      year: 2008,
      kind: 'recording',
      note: 'My confirmed date',
    })
    await f.classifier.wait()
    t = f.db.get(t.id)!
    assert.throws(
      () =>
        r.accept({
          id: t.id,
          revision: t.revision,
          resultId: ev.result!.id,
          candidate: 0,
        }),
      /saved era year differs/
    )
    assert.equal(f.classifier.track(t.id)?.era?.year, 2008)
  } finally {
    await f.close(r)
  }
})

test('schema 3 migration backs up the prior catalog and retains manual classification, source settings and era dates', async () => {
  const f = await fixture()
  let t = f.add()
  f.db.updateDecision([{ id: t.id, revision: t.revision }], 'category', 'Pop')
  f.db.sourceEnabled(f.source.id, false)
  await f.classifier.close()
  f.db.db.exec(
    'DROP TABLE playlist_exports;DROP TABLE playlist_approvals;DROP TABLE duplicate_decisions;DROP TABLE duplicate_job;DROP TABLE file_hashes;DROP TRIGGER research_approved_insert;DROP TRIGGER research_approved_update;DROP TRIGGER research_approved_delete;DROP TABLE research_results;DROP TABLE research_approved;DROP TABLE research_queue;DROP TABLE research_job;PRAGMA user_version=3;'
  )
  f.db.close()
  const upgraded = new LibraryDB(path.join(f.directory, 'profile'))
  try {
    assert.equal(upgraded.db.pragma('user_version', { simple: true }), 8)
    assert.equal(upgraded.get(t.id)?.category, 'Pop')
    assert.equal(upgraded.get(t.id)?.manual, true)
    assert.equal(upgraded.source(f.source.id)?.enabled, false)
    const backups = (await readdir(path.join(f.directory, 'profile'))).filter(n =>
      n.startsWith('before-schema-4-')
    )
    assert.equal(backups.length, 1)
    const original = new Database(path.join(f.directory, 'profile', backups[0]!))
    assert.equal(original.pragma('user_version', { simple: true }), 3)
    original.close()
  } finally {
    upgraded.close()
  }
})

test("research dates validate calendar precision and proposals follow the user's current literal rules", () => {
  assert.equal(yearOf('2007'), 2007)
  assert.equal(yearOf('2008-02-29'), 2008)
  assert.equal(yearOf('2007-02-29'), null)
  assert.equal(yearOf('2007-19-01'), null)
  assert.equal(yearOf('2099'), null)
  const candidate = c({ genre: 'Fixture Club Style', year: null, date: null })
  assert.equal(categoryFor(input, candidate), null)
  assert.equal(
    categoryFor(input, candidate, [
      {
        id: randomUUID(),
        field: 'genre',
        match: 'Fixture Club Style',
        category: 'Jersey Club',
        createdAt: new Date().toISOString(),
      },
    ]),
    'Jersey Club'
  )
})

test('fresh conflicting research exposes a reviewable conflict and preserves the saved genre/year', async () => {
  const f = await fixture()
  const mock: ResearchAdapter = { lookup: async () => result() }
  const r = new Researcher(f.db, f.classifier, () => {}, {
    musicbrainz: mock,
  })
  try {
    const t = f.add()
    r.start(plan(r, [t.id]).token)
    await r.wait()
    let ev = r.track(t.id)
    r.accept({
      id: t.id,
      revision: f.db.get(t.id)!.revision,
      resultId: ev.result!.id,
      candidate: 0,
    })
    await f.classifier.wait()
    const replacement = result('musicbrainz', c({ genre: 'Bachata', year: 2008, date: '2008' }))
    f.db.db
      .prepare("UPDATE research_results SET result=? WHERE fileId=? AND provider='musicbrainz'")
      .run(JSON.stringify(replacement), t.id)
    ev = r.track(t.id)
    assert.equal(ev.conflict, true)
    assert.equal(ev.approved?.candidate.genre, 'Reggaeton')
    assert.equal(ev.approved?.candidate.year, 2007)
    assert.equal(f.db.get(t.id)?.category, 'Reggaeton Old')
  } finally {
    await f.close(r)
  }
})

test('resuming a smaller preview preserves unpreviewed pending tracks and never contacts them', async () => {
  const f = await fixture()
  let sent: string[] = []
  const failing: ResearchAdapter = {
    lookup: async (i, signal) => {
      sent.push(i.title)
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')))
      )
    },
  }
  let r = new Researcher(f.db, f.classifier, () => {}, {
    musicbrainz: failing,
  })
  try {
    const a = f.add(),
      b = f.add({ title: 'Pending B' }),
      cTrack = f.add({ title: 'Pending C' })
    r.start(plan(r, [a.id, b.id, cTrack.id]).token)
    await new Promise<void>(resolve => setImmediate(resolve))
    r.pause()
    await r.wait()
    assert.equal(r.state().pending, 2)
    await r.close()
    const good: ResearchAdapter = {
      lookup: async i => {
        sent.push(i.title)
        return result('musicbrainz', c({ title: i.title }))
      },
    }
    r = new Researcher(f.db, f.classifier, () => {}, {
      musicbrainz: good,
    })
    const p = r.preview({
      provider: 'musicbrainz',
      scope: 'pending',
      ids: [],
      limit: 1,
    })
    r.start(p.token)
    await r.wait()
    assert.equal(r.state().pending, 1)
    assert.equal(r.state().job?.completed, 1)
    assert.equal(sent.length, 2)
    assert.equal(r.track(cTrack.id).result, null)
  } finally {
    await f.close(r)
  }
})
test('a cached preview cannot turn into an unpreviewed network request when its cache expires', async () => {
  const f = await fixture()
  let sent = 0
  const mock: ResearchAdapter = {
    lookup: async () => {
      sent++
      return result('musicbrainz')
    },
  }
  const r = new Researcher(f.db, f.classifier, () => {}, {
    musicbrainz: mock,
  })
  try {
    const a = f.add()
    r.start(plan(r, [a.id], 'musicbrainz').token)
    await r.wait()
    const p = plan(r, [a.id], 'musicbrainz')
    assert.equal(p.networkTracks, 0)
    const ev = r.track(a.id).result!
    ev.retrievedAt = '2000-01-01T00:00:00Z'
    f.db.db
      .prepare('UPDATE research_results SET result=? WHERE fileId=?')
      .run(JSON.stringify(ev), a.id)
    r.start(p.token)
    await r.wait()
    assert.equal(sent, 1)
    assert.equal(r.state().job?.cached, 1)
  } finally {
    await f.close(r)
  }
})

test('MusicBrainz errors retain safe diagnostics and stop a failed batch without losing unvisited tracks', async () => {
  const f = await fixture()
  let calls = 0
  const mock: ResearchAdapter = {
    lookup: async () => {
      calls++
      throw new ProviderFailure(503)
    },
  }
  let r = new Researcher(f.db, f.classifier, () => {}, { musicbrainz: mock })
  try {
    const tracks = Array.from({ length: 50 }, (_, i) => f.add({ title: `Synthetic track ${i}` }))
    r.start(
      plan(
        r,
        tracks.map(t => t.id)
      ).token
    )
    await r.wait()
    assert.equal(calls, 1)
    assert.equal(r.state().pending, 49)
    assert.equal(r.state().job?.failedTrack?.id, tracks[0]!.id)
    assert.deepEqual(r.state().job?.failure, { kind: 'http', status: 503 })
    assert.match(r.state().job!.message, /temporarily unavailable/)
    await r.close()
    r = new Researcher(f.db, f.classifier, () => {}, { musicbrainz: mock })
    assert.equal(r.state().job?.failure?.status, 503)
    assert.equal(
      r.preview({
        provider: 'musicbrainz',
        scope: 'pending',
        ids: [],
        limit: 50,
      }).tracks.length,
      49
    )
    assert.equal(calls, 1)
    for (const [error, expected] of [
      [new Error('private message'), { kind: 'unknown' }],
      [
        new Error('private', {
          cause: Object.assign(new Error('private'), { code: 'ECONNRESET' }),
        }),
        { kind: 'network' },
      ],
      [Object.assign(new Error('private'), { name: 'TimeoutError' }), { kind: 'timeout' }],
      [new ProviderFailure(429), { kind: 'http', status: 429 }],
    ] as const) {
      const failure = researchFailure(error)
      assert.deepEqual(failure, expected)
      assert.doesNotMatch(failureMessage(failure), /private|billing|API key/i)
    }
    const circular: { cause?: unknown } = {}
    circular.cause = circular
    assert.deepEqual(researchFailure(circular), { kind: 'unknown' })
    await assert.rejects(
      boundedFetch('https://musicbrainz.org/ws/2/', {}, (async () =>
        Response.json({ error: 'private message' }, { status: 403 })) as typeof fetch),
      error => {
        assert.deepEqual(researchFailure(error), { kind: 'http', status: 403 })
        assert.doesNotMatch(JSON.stringify(error), /private message/)
        return true
      }
    )
  } finally {
    await f.close(r)
  }
})

test('retiring AI removes its pending jobs/cache but preserves MusicBrainz cache and every user approval', async () => {
  const f = await fixture()
  const mock: ResearchAdapter = { lookup: async () => result() }
  let r = new Researcher(f.db, f.classifier, () => {}, { musicbrainz: mock })
  try {
    const t = f.add()
    r.start(plan(r, [t.id]).token)
    await r.wait()
    r.accept({
      id: t.id,
      revision: f.db.get(t.id)!.revision,
      resultId: r.track(t.id).result!.id,
      candidate: 0,
    })
    await f.classifier.wait()
    await r.close()
    // A saved choice from an older provider remains a user-approved choice.
    f.db.db
      .prepare(
        "UPDATE research_approved SET value=json_set(value,'$.provider','openai') WHERE fileId=?"
      )
      .run(t.id)
    f.db.db
      .prepare(
        "INSERT INTO research_results SELECT fileId,'openai',inputHash,signature,json_set(result,'$.provider','openai') FROM research_results WHERE fileId=?"
      )
      .run(t.id)
    f.db.db
      .prepare(
        "INSERT INTO research_queue SELECT fileId,'openai',inputHash,signature,'{}','pending' FROM research_results WHERE fileId=? AND provider='openai'"
      )
      .run(t.id)
    f.db.db
      .prepare(
        "UPDATE research_job SET data=json_set(data,'$.provider','openai','$.status','running')"
      )
      .run()
    const before = f.db.db.prepare('SELECT * FROM research_approved').all()
    const trackBefore = f.db.get(t.id)
    r = new Researcher(f.db, f.classifier, () => {}, { musicbrainz: mock })
    assert.equal(r.state().pending, 0)
    assert.equal(r.state().job, null)
    assert.equal(r.state().results, 1)
    assert.equal(r.state().approved, 1)
    assert.deepEqual(f.db.db.prepare('SELECT * FROM research_approved').all(), before)
    assert.deepEqual(f.db.get(t.id), trackBefore)
    assert.equal(r.track(t.id).approved?.current, true)
    assert.equal(plan(r, [t.id]).networkTracks, 0)
    assert.throws(
      () =>
        r.preview({
          provider: 'openai',
          scope: 'selected',
          ids: [t.id],
          limit: 1,
        } as never),
      /Only MusicBrainz/
    )
    assert.equal(
      (
        f.db.db
          .prepare("SELECT count(*) n FROM research_results WHERE provider='openai'")
          .get() as { n: number }
      ).n,
      0
    )
    await r.close()
    r = new Researcher(f.db, f.classifier, () => {}, { musicbrainz: mock })
    assert.deepEqual(f.db.db.prepare('SELECT * FROM research_approved').all(), before)
  } finally {
    await f.close(r)
  }
})

test('retired credential cleanup unlinks only owned files without reading data or following symlinks', async () => {
  const dir = await mkdtemp(path.resolve(process.cwd(), '../../work/retired-key-test-'))
  const unrelated = path.join(dir, 'unrelated.txt')
  await writeFile(unrelated, 'synthetic untouched content')
  await symlink(unrelated, path.join(dir, 'research-key.encrypted'))
  await writeFile(path.join(dir, `research-key-${randomUUID()}.tmp`), 'synthetic opaque bytes')
  await writeFile(path.join(dir, 'research-key-other.tmp'), 'unrelated')
  await removeRetiredResearchKey(dir)
  await removeRetiredResearchKey(dir)
  assert.deepEqual((await readdir(dir)).sort(), ['research-key-other.tmp', 'unrelated.txt'])
  assert.equal(await readFile(unrelated, 'utf8'), 'synthetic untouched content')
})

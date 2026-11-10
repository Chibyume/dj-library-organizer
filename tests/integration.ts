import './trash-library'
import './library-removals'
import './scanner-identity'
import './classifier-compat'
import './organization'
import './library-review'
import './track-trash'
import './automation'
import './managed-library-export'
import './research-import'
import './export-verification'
import './preparation'
import './research'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdir,
  writeFile,
  readFile,
  copyFile,
  link,
  symlink,
  rename,
  chmod,
  utimes,
} from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { LibraryDB } from '../src/db'
import { NativeHelper } from '../src/native'
import { Scanner, physicalKey, within } from '../src/scanner'
import { querySchema, requestSchemas, type LibraryQuery } from '../src/shared'
import { readableAudio, extractMetadata, PARSER_REVISION } from '../src/metadata'
import type { IAudioMetadata } from 'music-metadata'
import { CheckedTokenizer } from '../src/tokenizer'
// @ts-expect-error Synthetic fixture generator is deliberately plain JavaScript.
import { wav } from '../scripts/fixtures.mjs'

const dropClassificationSchema =
  'DROP TABLE playlist_exports;DROP TABLE playlist_approvals;DROP TABLE duplicate_decisions;DROP TABLE duplicate_job;DROP TABLE file_hashes;DROP TRIGGER research_approved_insert;DROP TRIGGER research_approved_update;DROP TRIGGER research_approved_delete;DROP TABLE research_results;DROP TABLE research_approved;DROP TABLE research_queue;DROP TABLE research_job;DROP TRIGGER classification_insert;DROP TRIGGER classification_evidence;DROP TRIGGER classification_snapshot;DROP TABLE classification_queue;DROP TABLE classification_results;DROP TABLE classification_job;DROP TABLE classification_rules;DROP TABLE era_years;DROP TABLE classification_settings;'
const project = process.cwd()
const base = path.resolve(project, '../../work/integration-' + Date.now())
const helperPath = path.join(project, 'dist/native/organizer-helper')
const metadataPath = path.join(project, 'dist/metadata-worker.cjs')
const QUERY: LibraryQuery = {
  search: '',
  view: 'all',
  sort: 'artist',
  direction: 'asc',
  offset: 0,
  limit: 1000,
}
const hash = async (p: string) =>
  createHash('sha256')
    .update(await readFile(p))
    .digest('hex')
async function fixture(name: string) {
  const directory = path.join(base, name)
  const root = path.join(directory, 'library')
  await mkdir(root, { recursive: true })
  const db = new LibraryDB(path.join(directory, 'profile'))
  const helper = new NativeHelper(helperPath)
  const scanner = new Scanner(db, helper, metadataPath, () => {})
  return {
    root,
    db,
    helper,
    scanner,
    close: () => {
      helper.close()
      db.close()
    },
  }
}
async function scan(scanner: Scanner, kind: 'smart' | 'discovery' = 'discovery') {
  scanner.start(kind)
  await scanner.wait()
  assert.equal(scanner.progress?.status, 'completed', JSON.stringify(scanner.progress))
}

test('native filesystem identity, bounded tokenizer, and actual local audio preview', async () => {
  const f = await fixture('native')
  try {
    const target = path.join(f.root, 'Accénted tone.wav')
    await writeFile(target, wav({ duration: 3 }))
    const info = await f.helper.inspect(target)
    assert.equal(info.regular, true)
    assert.equal(info.cloudOnly, false)
    assert.ok(physicalKey(info))
    const tokenizer = await CheckedTokenizer.create(target, info)
    const h = Buffer.alloc(4)
    await tokenizer.peekBuffer(h)
    assert.equal(h.toString(), 'RIFF')
    assert.equal(tokenizer.position, 0)
    await tokenizer.readBuffer(h)
    assert.equal(tokenizer.position, 4)
    await tokenizer.close()
    const shortcut = path.join(f.root, 'shortcut.wav')
    await symlink(target, shortcut)
    await assert.rejects(CheckedTokenizer.create(shortcut, info))
    const loaded = await f.helper.call('load', {
      path: target,
      fileId: 'native-test',
    })
    assert.equal(loaded.duration, 3)
    await f.helper.call('volume', { value: 0 })
    const playing = await f.helper.call('play')
    assert.equal(playing.playing, true)
    await f.helper.call('seek', { value: 1 })
    const paused = await f.helper.call('pause')
    assert.equal(paused.playing, false)
    assert.ok(paused.position >= 1)
  } finally {
    f.close()
  }
})

test('nested discovery distinguishes copies, hard links, roots, loops, exclusions, and corrupt input', async () => {
  const f = await fixture('discovery')
  try {
    const nested = path.join(f.root, 'Downloads', 'deep')
    await mkdir(nested, { recursive: true })
    const a = path.join(f.root, 'a.wav')
    const copy = path.join(f.root, 'copy.wav')
    const hard = path.join(f.root, 'hard.wav')
    const b = path.join(nested, 'b.wav')
    await writeFile(a, wav({ title: 'Árbol', artist: 'Zoé', year: '2007', bpm: '94' }))
    await copyFile(a, copy)
    await link(a, hard)
    await writeFile(b, wav({ title: 'Next Version', artist: 'Ana', year: '2008', bpm: '128' }))
    await symlink(f.root, path.join(nested, 'loop'))
    await writeFile(path.join(nested, 'partial.wav.crdownload'), Buffer.from('partial'))
    await mkdir(path.join(f.root, 'Caches'))
    await writeFile(path.join(f.root, 'Caches', 'skip.wav'), wav())
    await writeFile(path.join(f.root, 'bad.mp3'), Buffer.from('corrupt fixture'))
    const before = await Promise.all([a, copy, b].map(hash))
    f.db.addSource(f.root)
    f.db.addSource(nested)
    await scan(f.scanner)
    const list = f.db.list(QUERY)
    assert.equal(list.total, 4)
    assert.equal(list.tracks.filter(t => t.title === 'Árbol').length, 2)
    assert.equal(list.tracks.find(t => t.title === 'Next Version')?.bpm, 128)
    assert.equal(list.tracks.find(t => t.filename === 'bad.mp3')?.availability, 'unsupported')
    assert.ok(f.scanner.progress!.skipped >= 3)
    assert.ok(f.scanner.progress!.issues.some(i => i.path.endsWith('bad.mp3')))
    assert.deepEqual(await Promise.all([a, copy, b].map(hash)), before)
    const year = f.db.list({ ...QUERY, sort: 'year' }).tracks
    assert.equal(year[0]?.year, 2007)
    assert.equal(year.at(-1)?.year, null)
    assert.equal(f.db.list({ ...QUERY, search: 'Árbol' }).total, 2)
    assert.equal(f.db.list({ ...QUERY, search: '%' }).total, 0)
    const selected = list.tracks.find(t => t.title === 'Next Version')!
    f.db.updateDecision(
      [{ id: selected.id, revision: selected.revision }],
      'category',
      'Reggaeton New'
    )
    const evidenceBefore = (
      f.db.db.prepare('SELECT COUNT(*) n FROM tag_evidence').get() as {
        n: number
      }
    ).n
    await scan(f.scanner, 'smart')
    assert.equal(f.db.get(selected.id)?.category, 'Reggaeton New')
    assert.equal(f.db.get(selected.id)?.manual, true)
    assert.equal(f.scanner.progress!.changed, 0)
    assert.equal(
      (
        f.db.db.prepare('SELECT COUNT(*) n FROM tag_evidence').get() as {
          n: number
        }
      ).n,
      evidenceBefore
    )
    assert.deepEqual(await Promise.all([a, copy, b].map(hash)), before)
  } finally {
    f.close()
  }
})

test('manual decisions persist; stale batch decisions roll back atomically', async () => {
  const f = await fixture('decisions')
  let closed = false
  try {
    for (const name of ['a', 'b'])
      await writeFile(path.join(f.root, name + '.wav'), wav({ title: name }))
    f.db.addSource(f.root)
    await scan(f.scanner)
    const [a, b] = f.db.list(QUERY).tracks
    assert.ok(a && b)
    assert.throws(
      () =>
        f.db.updateDecision(
          [
            { id: a.id, revision: a.revision },
            { id: b.id, revision: b.revision + 1 },
          ],
          'category',
          'Bachata'
        ),
      /selection changed/
    )
    assert.equal(f.db.get(a.id)?.category, null)
    f.db.updateDecision([{ id: a.id, revision: a.revision }], 'category', 'Bachata')
    const dbPath = f.db.directory
    f.close()
    closed = true
    const reopened = new LibraryDB(dbPath)
    assert.equal(reopened.get(a.id)?.category, 'Bachata')
    assert.equal(reopened.get(a.id)?.manual, true)
    reopened.close()
  } finally {
    if (!closed) f.close()
  }
})

test('same-size content changes are detected and manual classifications retained', async () => {
  const f = await fixture('changed')
  try {
    const file = path.join(f.root, 'track.wav')
    await writeFile(file, Buffer.alloc(0))
    await new Promise(r => setTimeout(r, 10))
    await writeFile(file, wav({ title: 'AAAA', year: '2007' }))
    f.db.addSource(f.root)
    await scan(f.scanner)
    const first = f.db.list(QUERY).tracks[0]!
    f.db.updateDecision([{ id: first.id, revision: first.revision }], 'category', 'Reggaeton Old')
    const nativeBefore = await f.helper.inspect(file)
    await writeFile(file, wav({ title: 'BBBB', year: '2008' }))
    const [sec, ns] = nativeBefore.mtime.split(':')
    await utimes(file, new Date(), Number(sec) + Number(ns) / 1e9)
    await scan(f.scanner, 'smart')
    const updated = f.db.get(first.id)!
    assert.equal(updated.title, 'BBBB')
    assert.equal(updated.category, 'Reggaeton Old')
    assert.equal(updated.review, 'File Changed')
    assert.equal(f.scanner.progress?.changed, 1)
    const moved = path.join(f.root, 'new-name.wav')
    await rename(file, moved)
    await scan(f.scanner)
    assert.equal(f.db.summary().files, 1)
    assert.equal(f.db.get(first.id)?.path, moved)
  } finally {
    f.close()
  }
})

test('disconnected source remains unavailable, then reconciles without new instances', async () => {
  const f = await fixture('offline')
  try {
    await writeFile(path.join(f.root, 'track.wav'), wav())
    f.db.addSource(f.root)
    await scan(f.scanner)
    const id = f.db.list(QUERY).tracks[0]!.id
    await rename(f.root, f.root + '-offline')
    await scan(f.scanner, 'smart')
    assert.equal(f.db.get(id)?.availability, 'unavailable')
    assert.equal(f.db.sources()[0]?.status, 'unavailable')
    assert.equal(f.scanner.progress?.coverage, 'partial')
    await rename(f.root + '-offline', f.root)
    await scan(f.scanner, 'smart')
    assert.equal(f.db.get(id)?.availability, 'available')
    assert.equal(f.db.summary().files, 1)
    assert.equal(f.scanner.progress?.newFiles, 0)
  } finally {
    f.close()
  }
})

test('denied directory reports partial coverage and does not tombstone unvisited tracks', async () => {
  const f = await fixture('denied')
  const denied = path.join(f.root, 'denied')
  try {
    await mkdir(denied)
    await writeFile(path.join(denied, 'track.wav'), wav())
    f.db.addSource(f.root)
    await scan(f.scanner)
    await chmod(denied, 0)
    await scan(f.scanner)
    assert.equal(f.scanner.progress?.coverage, 'partial')
    assert.ok(f.scanner.progress?.issues.length)
    assert.notEqual(f.db.list(QUERY).tracks[0]?.availability, 'missing')
  } finally {
    await chmod(denied, 0o700)
    f.close()
  }
})

test('cancelled scan resumes its durable directory queue across a DB restart', async () => {
  const f = await fixture('resume')
  let dbClosed = false
  try {
    for (let i = 0; i < 35; i++)
      await writeFile(path.join(f.root, `${i}.wav`), wav({ title: `Fixture ${i}` }))
    f.db.addSource(f.root)
    f.scanner.start('discovery')
    await new Promise(r => setTimeout(r, 130))
    f.scanner.cancel()
    await f.scanner.wait()
    assert.equal(f.scanner.progress?.status, 'cancelled')
    assert.ok(f.db.summary().files < 35)
    const dbPath = f.db.directory
    f.db.close()
    dbClosed = true
    const db = new LibraryDB(dbPath)
    const scanner = new Scanner(db, f.helper, metadataPath, () => {})
    await scan(scanner)
    assert.equal(db.summary().files, 35)
    db.close()
  } finally {
    f.helper.close()
    if (!dbClosed) f.db.close()
  }
})

test('cloud-only availability branch inventories without reading content (injected provider state)', async () => {
  const f = await fixture('cloud')
  try {
    const file = path.join(f.root, 'cloud.wav')
    await writeFile(file, Buffer.from('contents must not be parsed'))
    const instrumented = {
      inspect: async (p: string) => {
        const info = await f.helper.inspect(p)
        return p === file ? { ...info, cloudOnly: true } : info
      },
    } as NativeHelper
    const scanner = new Scanner(f.db, instrumented, metadataPath, () => {})
    f.db.addSource(f.root)
    await scan(scanner)
    const t = f.db.list(QUERY).tracks[0]!
    assert.equal(t.availability, 'cloud-only')
    assert.match(t.metadataError!, /not opened/)
    assert.equal(t.title, null)
  } finally {
    f.close()
  }
})

test('broad-root Smart Scan only traverses remembered music directories and Downloads', async () => {
  const f = await fixture('smart-scope')
  try {
    for (const dir of ['Downloads', 'Known', 'Elsewhere']) await mkdir(path.join(f.root, dir))
    await writeFile(path.join(f.root, 'Known', 'one.wav'), wav())
    f.db.addSource(f.root, false, true)
    await scan(f.scanner)
    await writeFile(path.join(f.root, 'Elsewhere', 'unseen.wav'), wav())
    await writeFile(path.join(f.root, 'Downloads', 'new.wav'), wav())
    await scan(f.scanner, 'smart')
    assert.equal(f.db.summary().files, 2)
    assert.equal(f.db.list({ ...QUERY, search: 'unseen' }).total, 0)
    await scan(f.scanner)
    assert.equal(f.db.summary().files, 3)
  } finally {
    f.close()
  }
})

test('IPC rejects arbitrary commands, path injection, invalid categories, and unsafe query limits', () => {
  assert.equal(Object.hasOwn(requestSchemas, 'readFile'), false)
  assert.equal(Object.hasOwn(requestSchemas, 'execute'), false)
  assert.throws(() => querySchema.parse({ ...QUERY, sort: 'artist; DROP TABLE files' }))
  assert.throws(() => querySchema.parse({ ...QUERY, limit: 100000 }))
  assert.throws(() => requestSchemas.reveal.parse('/etc/passwd'))
  assert.throws(() =>
    requestSchemas.classify.parse({
      changes: [{ id: 'not-an-id', revision: 0 }],
      category: 'Invented',
    })
  )
  assert.equal(within('/approved', '/approved-other/file'), false)
  assert.equal(within('/approved', '/approved/../outside'), false)
  assert.equal(within('/approved', '/approved/music/song.wav'), true)
})

test('synthetic WAV, MP3, AAC, ALAC, FLAC and AIFF inventory and native preview on this Mac', async () => {
  const f = await fixture('formats')
  try {
    const source = path.join(f.root, 'tone.wav')
    await writeFile(source, wav({ duration: 3 }))
    for (const [name, codec] of [
      ['tone.mp3', 'libmp3lame'],
      ['aac.m4a', 'aac'],
      ['alac.m4a', 'alac'],
      ['tone.flac', 'flac'],
      ['tone.aiff', 'pcm_s16be'],
    ])
      execFileSync(
        '/opt/homebrew/bin/ffmpeg',
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          source,
          '-c:a',
          codec!,
          '-y',
          path.join(f.root, name!),
        ],
        { stdio: 'pipe' }
      )
    f.db.addSource(f.root)
    await scan(f.scanner)
    assert.equal(f.db.summary().files, 6)
    assert.equal(f.db.summary().unavailable, 0)
    for (const track of f.db.list(QUERY).tracks) {
      const loaded = await f.helper.call('load', {
        path: track.path,
        fileId: track.id,
      })
      assert.ok(loaded.duration > 2.8, track.filename)
      await f.helper.call('volume', { value: 0 })
      assert.equal((await f.helper.call('play')).playing, true, track.filename)
      await f.helper.call('pause')
    }
  } finally {
    f.close()
  }
})

test('resume preserves selected source scope and seeds sources not yet visited', async () => {
  const f = await fixture('resume-scope')
  const secondary = path.join(base, 'resume-secondary')
  const unrelated = path.join(base, 'resume-unrelated')
  try {
    await mkdir(secondary, { recursive: true })
    await mkdir(unrelated, { recursive: true })
    for (let i = 0; i < 25; i++) await writeFile(path.join(f.root, `${i}.wav`), wav())
    await writeFile(path.join(secondary, 'late.wav'), wav())
    await writeFile(path.join(unrelated, 'keep.wav'), wav())
    const first = f.db.addSource(f.root)
    const second = f.db.addSource(secondary)
    const third = f.db.addSource(unrelated)
    f.scanner.start('discovery', [third])
    await f.scanner.wait()
    const unrelatedTrack = f.db.list({
      ...QUERY,
      view: 'source',
      value: third.id,
    }).tracks[0]!
    f.scanner.start('discovery', [first, second])
    await new Promise(r => setTimeout(r, 100))
    f.scanner.cancel()
    await f.scanner.wait()
    assert.equal(f.scanner.progress?.status, 'cancelled')
    await scan(f.scanner)
    assert.equal(f.db.summary().files, 27)
    assert.equal(f.db.get(unrelatedTrack.id)?.availability, 'available')
    assert.deepEqual(f.scanner.progress?.sourceIds, [first.id, second.id])
  } finally {
    f.close()
  }
})

test('invalid cached metadata is not treated as available after a source reconnects', async () => {
  const f = await fixture('corrupt-reconnect')
  try {
    await writeFile(path.join(f.root, 'bad.mp3'), Buffer.from('invalid fixture'))
    f.db.addSource(f.root)
    await scan(f.scanner)
    const id = f.db.list(QUERY).tracks[0]!.id
    await rename(f.root, f.root + '-offline')
    await scan(f.scanner, 'smart')
    await rename(f.root + '-offline', f.root)
    await scan(f.scanner, 'smart')
    assert.equal(f.db.get(id)?.availability, 'unsupported')
  } finally {
    f.close()
  }
})

test('50,000-record catalog keeps bounded pages and numeric/search queries responsive', async () => {
  const f = await fixture('catalog-scale')
  try {
    const source = f.db.addSource(f.root)
    const insert = f.db.db.prepare(
      "INSERT INTO files(id,physicalKey,path,filename,sourceId,signature,artist,title,bpm,year,genre,format,size,availability,addedAt,updatedAt,tags) VALUES(?,?,?,?,?,'fixture',?,?,?,?,?,'PCM',1024,'available',?,?, '{}')"
    )
    const now = new Date().toISOString()
    f.db.db.transaction(() => {
      for (let i = 0; i < 50000; i++)
        insert.run(
          randomUUID(),
          'synthetic:' + i,
          path.join(f.root, i + '.wav'),
          i + '.wav',
          source.id,
          'Artist ' + (i % 1000),
          'Track ' + i,
          i % 3 ? 70 + (i % 110) : null,
          i % 7 ? 1960 + (i % 66) : null,
          'Test',
          now,
          now
        )
    })()
    const samples: number[] = []
    for (let i = 0; i < 15; i++) {
      const start = performance.now()
      const page = f.db.list({
        ...QUERY,
        sort: i % 2 ? 'bpm' : 'year',
        direction: i % 2 ? 'desc' : 'asc',
        search: i % 3 === 0 ? 'Track 42' : '',
        offset: 0,
        limit: 500,
      })
      samples.push(performance.now() - start)
      assert.ok(page.tracks.length <= 500)
      assert.ok(page.total >= 111)
    }
    const p95 = samples.sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!
    assert.ok(p95 < 1000, `Catalog query p95 ${p95.toFixed(1)}ms exceeded the regression ceiling.`)
    const report = {
      records: 50000,
      queries: samples.length,
      pageLimit: 500,
      p95Milliseconds: Number(p95.toFixed(2)),
      maximumMilliseconds: Number(Math.max(...samples).toFixed(2)),
      scope: 'SQLite synthetic catalog queries; not a full audio scan or renderer benchmark',
    }
    await writeFile(
      path.resolve(project, '../../work/catalog-benchmark.json'),
      JSON.stringify(report, null, 2)
    )
    console.log('Catalog benchmark: ' + JSON.stringify(report))
  } finally {
    f.close()
  }
})

test('recognized audio is retained when sample rate is unreported; video alone is rejected', () => {
  const metadata = {
    format: {
      codec: 'MPEG-4/AAC',
      hasAudio: true,
      trackInfo: [
        { codecId: 'avc1', duration: 6638, bitrate: 7459509 },
        { codecId: 'mp4a', duration: 6638.336, bitrate: 317374 },
      ],
    },
    common: {},
    native: {},
  } as unknown as IAudioMetadata
  assert.equal(readableAudio(metadata), true)
  const extracted = extractMetadata(metadata)
  assert.equal(extracted.sampleRate, null)
  assert.equal(extracted.duration, 6638.336)
  assert.equal(extracted.bitrate, 317374)
  assert.equal(
    readableAudio({
      ...metadata,
      format: { ...metadata.format, codec: 'H264', hasAudio: false },
    }),
    false
  )
})

test('truncated fast-start M4A retains readable tags but is flagged incomplete', async () => {
  const f = await fixture('truncated-m4a')
  try {
    const source = path.join(f.root, 'tone.wav')
    const target = path.join(f.root, 'partial.m4a')
    await writeFile(source, wav({ duration: 3 }))
    execFileSync('/opt/homebrew/bin/ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      source,
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      '-metadata',
      'title=Partial Tone',
      '-metadata',
      'artist=Fixture Artist',
      '-y',
      target,
    ])
    const data = await readFile(target)
    let offset = 0
    while (offset + 8 <= data.length && data.toString('ascii', offset + 4, offset + 8) !== 'mdat')
      offset += data.readUInt32BE(offset)
    assert.equal(data.toString('ascii', offset + 4, offset + 8), 'mdat')
    await writeFile(
      target,
      data.subarray(0, offset + 8 + Math.floor((data.readUInt32BE(offset) - 8) / 2))
    )
    const before = await hash(target)
    f.db.addSource(f.root)
    await scan(f.scanner)
    const track = f.db.list({ ...QUERY, search: 'partial.m4a' }).tracks[0]!
    assert.equal(track.availability, 'corrupt')
    assert.match(track.metadataError!, /Incomplete or malformed MP4/)
    assert.equal(track.title, 'Partial Tone')
    assert.equal(track.tags.partialRead, true)
    assert.equal(track.duration, null)
    assert.equal(await hash(target), before)
  } finally {
    f.close()
  }
})

test('ordinary nested Library, System, bin and dev folders are discoverable', async () => {
  const f = await fixture('ordinary-folders')
  try {
    for (const [index, name] of ['library', 'Library', 'System', 'bin', 'dev'].entries()) {
      const dir = path.join(f.root, 'music', String(index), name)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, name + '.wav'), wav({ title: name }))
    }
    f.db.addSource(f.root)
    await scan(f.scanner)
    assert.equal(f.db.summary().files, 5)
    assert.equal(f.scanner.progress?.coverage, 'complete')
  } finally {
    f.close()
  }
})

test('parser revision upgrade retries an unchanged previously rejected file without losing manual choices', async () => {
  const f = await fixture('parser-upgrade')
  try {
    await writeFile(path.join(f.root, 'track.wav'), wav())
    f.db.addSource(f.root)
    await scan(f.scanner)
    const first = f.db.list(QUERY).tracks[0]!
    f.db.updateDecision([{ id: first.id, revision: first.revision }], 'category', 'Bachata')
    f.db.db
      .prepare(
        "UPDATE files SET availability='unsupported',metadataError='Legacy parser rejection',tags=? WHERE id=?"
      )
      .run(JSON.stringify({ ...first.tags, organizerParserRevision: 1 }), first.id)
    await scan(f.scanner, 'smart')
    const updated = f.db.get(first.id)!
    assert.equal(updated.availability, 'available')
    assert.equal(updated.category, 'Bachata')
    assert.equal(updated.tags.organizerParserRevision, PARSER_REVISION)
    assert.equal(f.scanner.progress?.changed, 1)
    await scan(f.scanner, 'smart')
    assert.equal(f.scanner.progress?.changed, 0)
  } finally {
    f.close()
  }
})

// All XML fixtures below are generated under work/ and reference only generated tones.
import { Rekordbox } from '../src/rekordbox'
import { pathToFileURL } from 'node:url'
import { readdir, stat, rm } from 'node:fs/promises'
import Database from 'better-sqlite3'
import type { XMLProgress } from '../src/shared'
const escapeXML = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function rbXML(tracks: Record<string, string>[], playlist = '', extra = '') {
  return `<?xml version="1.0" encoding="UTF-8"?><DJ_PLAYLISTS Version="1.0.0"><PRODUCT Name="rekordbox" Version="7.synthetic" Company="Fixture"/><COLLECTION Entries="${tracks.length}">${tracks
    .map(
      t =>
        `<TRACK ${Object.entries(t)
          .map(([k, v]) => `${k}="${escapeXML(v)}"`)
          .join(
            ' '
          )}><TEMPO Inizio="0.0" Bpm="128" Metro="4/4" Battito="1"/><POSITION_MARK Name="Intro &amp; go" Type="0" Start="0.3" Num="0"/><CUSTOM Value="preserved"/></TRACK>`
    )
    .join(
      ''
    )}</COLLECTION><PLAYLISTS><NODE Type="0" Name="ROOT" Count="${playlist ? 1 : 0}">${playlist}</NODE></PLAYLISTS>${extra}</DJ_PLAYLISTS>`
}
async function xmlFixture(name: string, notify: (p: XMLProgress) => void = () => {}) {
  const f = await fixture('xml-' + name)
  const rb = new Rekordbox(f.db, f.helper, path.join(project, 'dist/xml-worker.cjs'), notify)
  await rb.initialize()
  return {
    ...f,
    rb,
    xml: path.join(path.dirname(f.root), 'export.xml'),
    close: async () => {
      await rb.close()
      f.close()
    },
  }
}
async function chooseImport(f: Awaited<ReturnType<typeof xmlFixture>>, content: string) {
  await writeFile(f.xml, content)
  const chosen = await f.rb.find([f.xml])
  assert.equal(chosen.candidates[0]?.valid, true, JSON.stringify(chosen))
  return f.rb.import(chosen.candidates[0]!.id)
}

test('XML local snapshot preserves raw bytes, hierarchy, both membership keys, preparation, and manual decisions', async () => {
  const f = await xmlFixture('preservation')
  try {
    const audio = path.join(f.root, 'Accént & percent %.wav')
    await writeFile(audio, wav({ duration: 3, title: 'Tone', artist: 'Fixture Artist' }))
    f.db.addSource(f.root)
    await scan(f.scanner)
    let file = f.db.list(QUERY).tracks[0]!
    f.db.updateDecision([{ id: file.id, revision: file.revision }], 'category', 'Jersey Club')
    file = f.db.get(file.id)!
    const url = pathToFileURL(audio).href.replace('file:///', 'file://localhost/')
    const nodes = `<NODE Type="0" Name="Sets &amp; prep" Count="2"><NODE Type="1" Name="By ID" KeyType="0" Entries="2"><TRACK Key="12"/><TRACK Key="999"/></NODE><NODE Type="1" Name="By path" KeyType="1" Entries="1"><TRACK Key="${escapeXML(url)}"/></NODE></NODE>`
    const raw = rbXML(
      [
        {
          TrackID: '12',
          Location: url,
          Name: 'XML differs',
          Artist: 'Fixture Artist',
          TotalTime: '3',
          Size: String(file.size),
          Unknown: 'keep me',
        },
      ],
      nodes,
      '<UNKNOWN Attribute="kept">custom text</UNKNOWN>'
    )
    const audioBefore = await hash(audio)
    const snapshot = await chooseImport(f, raw)
    assert.equal(snapshot.counts.referenced, 1)
    assert.equal(snapshot.counts.conflict, 1)
    assert.equal(snapshot.playlists, 2)
    assert.equal(snapshot.dangling, 1)
    const entry = f.rb.list({ status: 'all', offset: 0, limit: 10 }).entries[0]!
    assert.equal(await hash(audio), audioBefore)
    assert.equal(entry.fileId, file.id)
    assert.equal(entry.localPath, audio.normalize('NFC'))
    assert.equal(entry.attrs.Unknown, 'keep me')
    assert.equal(entry.cues[0]?.Name, 'Intro & go')
    assert.equal(entry.tempo[0]?.Bpm, '128')
    assert.deepEqual(entry.playlists, ['By ID', 'By path'])
    assert.equal(await readFile(path.join(f.rb.directory, snapshot.hash + '.xml'), 'utf8'), raw)
    assert.equal(await readFile(f.xml, 'utf8'), raw)
    assert.equal((await stat(path.join(f.rb.directory, snapshot.hash + '.xml'))).mode & 0o222, 0)
    assert.equal(f.db.get(file.id)?.category, 'Jersey Club')
    assert.equal(f.db.get(file.id)?.title, file.title)
    assert.equal(f.db.get(file.id)?.revision, file.revision)
    assert.equal(f.rb.track(file.id).entries.length, 1)
    assert.equal(f.rb.track(file.id).preview, 'untested')
    f.db.previewEvidence(file.id, 'played', null)
    assert.equal(f.rb.track(file.id).preview, 'played')
  } finally {
    await f.close()
  }
})

test('XML folder selection offers multiple valid candidates and rejects malformed/foreign XML without silently importing', async () => {
  const f = await xmlFixture('candidates')
  try {
    const folder = path.dirname(f.xml)
    await mkdir(path.join(folder, 'nested'))
    await writeFile(f.xml, rbXML([]))
    await writeFile(path.join(folder, 'nested', 'second.XML'), rbXML([]))
    await writeFile(path.join(folder, 'invalid.xml'), '<settings/>')
    await symlink(f.xml, path.join(folder, 'link.xml'))
    const found = await f.rb.find([folder])
    assert.equal(found.candidates.length, 3)
    assert.equal(found.candidates.filter(c => c.valid).length, 2)
    assert.equal(f.rb.summary(), null)
    assert.equal(found.candidates.find(c => !c.valid)?.error?.includes('DJ_PLAYLISTS'), true)
    await assert.rejects(f.rb.import(randomUUID()), /expired/)
    const s = await f.rb.import(found.candidates.find(c => c.valid)!.id)
    assert.equal(s.tracks, 0)
  } finally {
    await f.close()
  }
})

test('XML strict parser rejects DTD/entities, wrong counts, duplicate IDs, deep/large tokens, invalid UTF-8 and encoding', async () => {
  const f = await xmlFixture('hostile')
  try {
    const content = rbXML([{ TrackID: '1', Location: 'file://localhost/generated/tone.wav' }])
    const bad = [
      content.replace(
        '<DJ_PLAYLISTS',
        '<!DOCTYPE DJ_PLAYLISTS [<!ENTITY leak SYSTEM "file:///synthetic-secret">]><DJ_PLAYLISTS'
      ),
      content.replace(
        '<DJ_PLAYLISTS',
        '<!DOCTYPE DJ_PLAYLISTS [<!ENTITY a "&a;&a;">]><DJ_PLAYLISTS'
      ),
      content.replace('Name="rekordbox"', 'Name="&unknown;"'),
      content.replace('Entries="1"', 'Entries="2"'),
      rbXML([
        { TrackID: '1', Location: 'file:///one' },
        { TrackID: '1', Location: 'file:///two' },
      ]),
      content.replace(
        '</DJ_PLAYLISTS>',
        '<OTHER>'.repeat(66) + '</OTHER>'.repeat(66) + '</DJ_PLAYLISTS>'
      ),
      content.replace('Name="rekordbox"', 'Name="' + 'x'.repeat(70000) + '"'),
      content.replace('encoding="UTF-8"', 'encoding="UTF-16"'),
      content.slice(0, -7),
    ]
    for (const raw of bad) {
      await writeFile(f.xml, raw)
      const found = await f.rb.find([f.xml])
      assert.equal(found.candidates[0]?.valid, false, raw.slice(0, 90))
      assert.ok(found.candidates[0]?.error)
      assert.equal(f.rb.summary(), null)
    }
    await writeFile(f.xml, Buffer.from([0xff, 0xfe, 0x3c, 0]))
    assert.equal((await f.rb.find([f.xml])).candidates[0]?.valid, false)
  } finally {
    await f.close()
  }
})

test('XML path matching treats copies, case changes, replacement evidence and nonlocal/invalid URLs conservatively', async () => {
  const f = await xmlFixture('matching')
  try {
    const audio = path.join(f.root, 'Tone.wav'),
      copy = path.join(f.root, 'Other.wav')
    await writeFile(audio, wav({ duration: 3 }))
    await copyFile(audio, copy)
    f.db.addSource(f.root)
    await scan(f.scanner)
    const url = pathToFileURL(audio).href
    const snapshot = await chooseImport(
      f,
      rbXML([
        { TrackID: '1', Location: url },
        { TrackID: '2', Location: pathToFileURL(copy).href },
        { TrackID: '3', Location: url.toLowerCase() },
        { TrackID: '4', Location: url, Size: '5' },
        { TrackID: '5', Location: 'https://example.invalid/stream' },
        { TrackID: '6', Location: 'file://server/share/tone.wav' },
        { TrackID: '7', Location: 'file:///invalid%ZZ' },
        { TrackID: '8', Location: 'file:///not-discovered/tone.wav' },
        { TrackID: '9', Location: 'file:///encoded%2Fseparator.wav' },
      ])
    )
    assert.equal(snapshot.counts.referenced, 2)
    assert.equal(snapshot.counts.possible, 2)
    assert.equal(snapshot.counts.nonlocal, 2)
    assert.equal(snapshot.counts.invalid, 2)
    assert.equal(snapshot.counts.unmatched, 1)
    const entries = f.rb.list({ status: 'all', offset: 0, limit: 20 }).entries
    assert.notEqual(entries[0]?.fileId, entries[1]?.fileId)
    assert.equal(entries[3]?.fileId, null)
    assert.equal(entries[3]?.candidates.length, 1)
    assert.equal(f.rb.list({ status: 'conflict', offset: 0, limit: 20 }).total, 1)
    // A second observed physical instance at the same normalized path must not be guessed.
    f.db.db
      .prepare('INSERT INTO locations(fileId,sourceId,path,available) VALUES(?,?,?,1)')
      .run(entries[1]!.fileId!, f.db.addSource(path.dirname(f.root)).id, audio)
    await f.rb.reconcile()
    assert.equal(f.rb.list({ status: 'ambiguous', offset: 0, limit: 10 }).total, 3)
  } finally {
    await f.close()
  }
})

test('Failed/cancelled XML refresh and changed candidate retain the last good snapshot', async () => {
  const f = await xmlFixture('refresh')
  try {
    const s = await chooseImport(f, rbXML([]))
    await writeFile(f.xml, '<broken>')
    assert.equal((await f.rb.find([f.xml])).candidates[0]?.valid, false)
    assert.equal(f.rb.summary()?.id, s.id)
    await writeFile(f.xml, rbXML([]))
    const c = (await f.rb.find([f.xml])).candidates[0]!
    await writeFile(f.xml, rbXML([], '', '<changed/>'))
    await assert.rejects(f.rb.import(c.id), /changed after validation/)
    assert.equal(f.rb.summary()?.id, s.id)
    const pending = f.rb.find([f.xml])
    f.rb.cancel()
    await assert.rejects(pending, /cancelled/)
    assert.equal(f.rb.summary()?.id, s.id)
    const replacement = await chooseImport(
      f,
      rbXML([{ TrackID: '1', Location: 'file:///generated/unmatched.wav' }])
    )
    assert.notEqual(replacement.id, s.id)
    assert.equal(
      (
        f.db.db.prepare('SELECT COUNT(*) n FROM rb_snapshots').get() as {
          n: number
        }
      ).n,
      2
    )
    assert.equal((await readdir(path.join(f.rb.directory, 'work'))).length, 0)
  } finally {
    await f.close()
  }
})

test('XML reconciliation follows catalog changes without title-only merging or overwriting decisions', async () => {
  const f = await xmlFixture('reconcile')
  try {
    const p = path.join(f.root, 'Tone.wav')
    await writeFile(p, wav({ duration: 2 }))
    f.db.addSource(f.root)
    await scan(f.scanner)
    let file = f.db.list(QUERY).tracks[0]!
    f.db.updateDecision([{ id: file.id, revision: file.revision }], 'category', 'Bounce')
    await chooseImport(f, rbXML([{ TrackID: '1', Location: pathToFileURL(p).href }]))
    assert.equal(f.rb.track(file.id).entries[0]?.status, 'referenced')
    await rename(p, path.join(f.root, 'Renamed.wav'))
    await scan(f.scanner)
    await f.rb.reconcile()
    assert.equal(f.rb.track(file.id).entries[0]?.status, 'possible')
    assert.equal(f.rb.track(file.id).entries[0]?.fileId, null)
    assert.equal(f.db.get(file.id)?.category, 'Bounce')
    await writeFile(p, wav({ duration: 4 }))
    await scan(f.scanner)
    await f.rb.reconcile()
    assert.equal(f.rb.track(file.id).entries.length, 0)
    assert.equal(f.rb.list({ status: 'referenced', offset: 0, limit: 10 }).total, 1)
  } finally {
    await f.close()
  }
})

test('50,000-track XML streams in a bounded worker, paginates, and remains cancellable', async () => {
  const events: XMLProgress[] = []
  const f = await xmlFixture('large', p => events.push(p))
  try {
    const tracks = Array.from({ length: 50000 }, (_, i) => ({
      TrackID: String(i),
      Location: `file:///generated/${i}.wav`,
      Name: `Synthetic ${i}`,
    }))
    await writeFile(f.xml, rbXML(tracks))
    let ticks = 0
    const timer = setInterval(() => ticks++, 10)
    const start = Date.now()
    try {
      const c = (await f.rb.find([f.xml])).candidates[0]!
      assert.equal(c.valid, true, c.error || '')
      const s = await f.rb.import(c.id)
      assert.equal(s.tracks, 50000)
      const page = f.rb.list({ status: 'unmatched', offset: 49950, limit: 50 })
      assert.equal(page.total, 50000)
      assert.equal(page.entries.length, 50)
      assert.equal(page.entries[0]?.trackKey, '49950')
      assert.ok(ticks > 5)
      assert.ok(events.some(e => e.phase === 'reading' && e.tracks > 0))
      console.log(
        `Synthetic XML benchmark: 50,000 tracks in ${Date.now() - start} ms; ${ticks} event-loop ticks.`
      )
    } finally {
      clearInterval(timer)
    }
    let cancelOnce = false
    const rb = new Rekordbox(f.db, f.helper, path.join(project, 'dist/xml-worker.cjs'), p => {
      if (p.phase === 'reading' && p.tracks > 0 && !cancelOnce) {
        cancelOnce = true
        rb.cancel()
      }
    })
    await rb.initialize()
    const previous = f.rb.summary()?.id
    await assert.rejects(rb.find([f.xml]), /cancelled/)
    assert.equal(f.rb.summary()?.id, previous)
    await rb.close()
  } finally {
    await f.close()
  }
})

test('Schema 1 upgrade backs up the catalog and source pausing retains files and decisions', async () => {
  const f = await fixture('xml-migration')
  try {
    await writeFile(path.join(f.root, 'Tone.wav'), wav({ duration: 2 }))
    const source = f.db.addSource(f.root)
    await scan(f.scanner)
    const file = f.db.list(QUERY).tracks[0]!
    f.db.updateDecision([{ id: file.id, revision: file.revision }], 'category', 'Dance')
    f.db.close()
    const old = new Database(path.join(path.dirname(f.root), 'profile/library.sqlite'))
    old.exec(
      dropClassificationSchema +
        'DROP TABLE rb_matches;DROP TABLE rb_memberships;DROP TABLE rb_nodes;DROP TABLE rb_tracks;DROP TABLE rb_snapshots;DROP TABLE preview_evidence;ALTER TABLE sources DROP COLUMN enabled;PRAGMA user_version=1;'
    )
    old.close()
    const upgraded = new LibraryDB(path.join(path.dirname(f.root), 'profile'))
    try {
      assert.equal(upgraded.get(file.id)?.category, 'Dance')
      const backups = (await readdir(upgraded.directory)).filter(p =>
        p.startsWith('before-schema-2')
      )
      assert.equal(backups.length, 1)
      const backup = new Database(path.join(upgraded.directory, backups[0]!), {
        readonly: true,
      })
      assert.equal(backup.pragma('user_version', { simple: true }), 1)
      assert.equal(
        (
          backup.prepare('SELECT category FROM files WHERE id=?').get(file.id) as {
            category: string
          }
        ).category,
        'Dance'
      )
      backup.close()
      upgraded.sourceEnabled(source.id, false)
      assert.equal(upgraded.sources()[0]?.enabled, false)
      assert.equal(upgraded.summary().files, 1)
      const scanner = new Scanner(upgraded, f.helper, metadataPath, () => {})
      assert.throws(() => scanner.start('smart'), /source folder/)
      upgraded.addSource(f.root)
      assert.equal(upgraded.sources()[0]?.enabled, true)
      assert.equal(upgraded.get(file.id)?.category, 'Dance')
    } finally {
      upgraded.close()
    }
  } finally {
    f.helper.close()
  }
})

test('XML IPC rejects arbitrary imports, oversized pages and unexpected query fields', () => {
  assert.throws(() => requestSchemas.xmlImport.parse('/tmp/export.xml'))
  assert.throws(() => requestSchemas.xmlDrop.parse(['relative.xml']))
  assert.throws(() => requestSchemas.xmlList.parse({ status: 'all', offset: 0, limit: 100000 }))
  assert.throws(() =>
    requestSchemas.xmlList.parse({
      status: 'all',
      offset: 0,
      limit: 50,
      path: '/tmp',
    })
  )
  assert.throws(() => requestSchemas.sourceEnabled.parse({ id: randomUUID(), enabled: 'true' }))
})

test('XML skips provider placeholders and inaccessible files without worker content reads', async () => {
  const events: XMLProgress[] = []
  const f = await xmlFixture('availability', p => events.push(p))
  try {
    await writeFile(f.xml, rbXML([]))
    const inspect = f.helper.inspect.bind(f.helper)
    f.helper.inspect = async p => ({
      ...(await inspect(p)),
      ...(p === f.xml ? { cloudOnly: true } : {}),
    })
    const cloud = await f.rb.find([f.xml])
    assert.equal(cloud.candidates.length, 0)
    assert.ok(cloud.warnings.some(w => w.includes('locally available')))
    assert.equal(
      events.some(e => e.phase === 'reading'),
      false
    )
    f.helper.inspect = inspect
    await chmod(f.xml, 0)
    try {
      const inaccessible = await f.rb.find([f.xml])
      assert.equal(inaccessible.candidates[0]?.valid, false)
      assert.equal(f.rb.summary(), null)
    } finally {
      await chmod(f.xml, 0o600)
    }
  } finally {
    await f.close()
  }
})

test('Cancelling XML matching or failing atomic activation preserves the previous snapshot and removes cancelled staging', async () => {
  const f = await xmlFixture('atomic')
  try {
    const previous = await chooseImport(f, rbXML([]))
    let cancelMatching = false
    const rb = new Rekordbox(f.db, f.helper, path.join(project, 'dist/xml-worker.cjs'), p => {
      if (cancelMatching && p.phase === 'matching') rb.cancel()
    })
    await rb.initialize()
    try {
      await writeFile(
        f.xml,
        rbXML(
          Array.from({ length: 1000 }, (_, i) => ({
            TrackID: String(i),
            Location: `file:///generated/${i}.wav`,
          }))
        )
      )
      const selected = (await rb.find([f.xml])).candidates[0]!
      cancelMatching = true
      await assert.rejects(rb.import(selected.id), /cancelled/)
      assert.equal(rb.summary()?.id, previous.id)
      assert.equal((await readdir(path.join(rb.directory, 'work'))).length, 0)
      cancelMatching = false
      const retry = (await rb.find([f.xml])).candidates[0]!
      f.db.db.exec(
        "CREATE TRIGGER synthetic_snapshot_failure BEFORE INSERT ON rb_matches BEGIN SELECT RAISE(ABORT,'synthetic activation failure'); END;"
      )
      try {
        await assert.rejects(rb.import(retry.id), /synthetic activation failure/)
        assert.equal(rb.summary()?.id, previous.id)
        assert.equal(
          (
            f.db.db.prepare('SELECT COUNT(*) n FROM rb_snapshots').get() as {
              n: number
            }
          ).n,
          1
        )
      } finally {
        f.db.db.exec('DROP TRIGGER synthetic_snapshot_failure')
      }
    } finally {
      await rb.close()
    }
  } finally {
    await f.close()
  }
})

test('Pausing a source prevents resuming its cancelled scope and bounded marker previews retain full snapshot data', async () => {
  const f = await xmlFixture('source-scope')
  try {
    const source = f.db.addSource(f.root)
    const other = path.join(path.dirname(f.root), 'other-source')
    await mkdir(other)
    const activeSource = f.db.addSource(other)
    await writeFile(path.join(other, 'Other.wav'), wav({ duration: 2 }))
    f.db.saveScan({
      id: randomUUID(),
      kind: 'discovery',
      status: 'cancelled',
      visited: 0,
      audio: 0,
      newFiles: 0,
      changed: 0,
      unchanged: 0,
      skipped: 0,
      bytes: 0,
      currentPath: '',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      sourceIds: [source.id],
      issues: [],
      coverage: 'partial',
    })
    f.db.sourceEnabled(source.id, false)
    await scan(f.scanner)
    assert.deepEqual(f.scanner.progress?.sourceIds, [activeSource.id])
    assert.equal(f.db.summary().files, 1)
    const raw = rbXML([{ TrackID: '1', Location: 'file:///generated/tone.wav' }]).replace(
      '<CUSTOM Value="preserved"/>',
      Array.from(
        { length: 80 },
        (_, i) => `<POSITION_MARK Name="Marker ${i}" Type="0" Start="${i}" Num="-1"/>`
      ).join('')
    )
    const s = await chooseImport(f, raw)
    const entry = f.rb.list({ status: 'all', offset: 0, limit: 10 }).entries[0]!
    assert.equal(entry.cueCount, 81)
    assert.equal(entry.cues.length, 50)
    assert.equal(
      (
        JSON.parse(
          (
            f.db.db.prepare('SELECT cues FROM rb_tracks WHERE snapshotId=?').get(s.id) as {
              cues: string
            }
          ).cues
        ) as unknown[]
      ).length,
      81
    )
    const tooLarge = raw
      .replace('<CUSTOM Value="preserved"/>', '')
      .replace(
        '</TRACK>',
        Array.from(
          { length: 20 },
          () => `<POSITION_MARK Name="${'x'.repeat(16000)}" Type="0" Start="0"/>`
        ).join('') + '</TRACK>'
      )
    await writeFile(f.xml, tooLarge)
    const rejected = (await f.rb.find([f.xml])).candidates[0]!
    assert.equal(rejected.valid, false)
    assert.match(rejected.error || '', /256 KiB/)
    assert.equal(f.rb.summary()?.id, s.id)
  } finally {
    await f.close()
  }
})

import { Classifier } from '../src/classifier'
import { propose, type ClassificationInput } from '../src/classification'
const classificationInput = (values: Partial<ClassificationInput> = {}): ClassificationInput => ({
  signature: 'fixture-current',
  filename: 'Synthetic.wav',
  title: 'Synthetic',
  genre: null,
  genres: [],
  year: null,
  originalYear: null,
  originalDate: null,
  availability: 'available',
  partial: false,
  xml: [],
  xmlOverflow: false,
  era: null,
  ...values,
})

test('local classifier maps requested genres and keeps actual musical style separate from categories', () => {
  const genres = [
    ['Dembow', 'Dembow'],
    ['Merengue Típico', 'Merengue'],
    ['Bachata', 'Bachata'],
    ['Latin R&B', 'Latin R&B'],
    ['Salsa', 'Salsa'],
    ['Philly Club', 'Jersey Club'],
    ['Baltimore Club', 'Jersey Club'],
    ['Miami Bass', 'Bounce'],
    ['New Orleans Bounce', 'Bounce'],
    ['Hip-Hop', 'Hip Hop'],
    ['R&B', 'R&B'],
    ['Pop', 'Pop'],
    ['Tech House', 'Dance'],
    ['Dancehall', 'Dancehall'],
    ['Afrobeats', 'Afrobeats'],
    ['Cumbia', 'Cumbia'],
    ['Plena', 'Plena'],
    ['Alternative Rock', 'Rock'],
  ]
  for (const [genre, category] of genres) {
    const result = propose(classificationInput({ genre, genres: [genre!] }))
    assert.equal(result.category, category)
    assert.equal(result.genre, genre)
    assert.equal(result.status, 'Ready for Approval')
    assert.ok(result.evidence.some(e => e.source === 'Embedded genre'))
  }
  for (const genre of ['Club', 'Urban', 'Unknown', 'Test'])
    assert.equal(propose(classificationInput({ genre })).category, null)
})

test('classifier protects recording versions, rejects weak title guesses, and requires workflow review', () => {
  const remix = propose(
    classificationInput({
      filename: 'Fixture (JERSEY CLUB REMIX) (2005).wav',
      genre: 'Hip Hop',
    })
  )
  assert.equal(
    propose(classificationInput({ title: 'Jersey', filename: 'Club Remix.wav' })).category,
    null
  )
  assert.equal(remix.category, 'Jersey Club')
  assert.equal(remix.basis, 'version label')
  assert.equal(remix.genre, 'jersey club')
  for (const title of [
    'Bounce With Me',
    'Bachata Heart',
    'Latin Night',
    'Club Life',
    'Synthetic Episode 42',
    'Intro',
    'Extended Mix',
    'Acapella',
    'Very Long Song',
  ]) {
    const result = propose(classificationInput({ title, filename: `${title}.wav` }))
    assert.equal(result.category, null)
    assert.ok(!result.candidates.includes('_JUNK') && !result.candidates.includes('_MIXES'))
  }
  for (const title of ['Full DJ Set', 'Drum Loop Sample Pack']) {
    const result = propose(classificationInput({ title, genre: 'House' }))
    assert.equal(result.category, title === 'Full DJ Set' ? '_MIXES' : '_JUNK')
    assert.equal(result.status, 'Needs Review')
  }
  assert.equal(propose(classificationInput({ genre: 'Bachata', partial: true })).category, null)
  assert.equal(
    propose(classificationInput({ genre: 'Bachata', availability: 'cloud-only' })).status,
    'File Unavailable'
  )
})

test('reggaeton era requires confirmed current recording/version year and uses exact 2007/2008 boundary', () => {
  assert.equal(propose(classificationInput({ genre: 'Reggaetón' })).status, 'Missing Year')
  for (const year of [2007, 2008, 2024]) {
    const unresolved = propose(
      classificationInput({ genre: 'Reggaeton', year, originalYear: 2001 })
    )
    assert.equal(unresolved.category, 'Reggaeton')
    assert.equal(unresolved.status, 'Verify Release Year')
  }
  for (const [year, category] of [
    [2007, 'Reggaeton Old'],
    [2008, 'Reggaeton New'],
  ] as const) {
    assert.equal(
      propose(
        classificationInput({
          genre: 'Reggaeton',
          year: 2025,
          era: { year, kind: 'recording', current: true },
        })
      ).category,
      category
    )
  }
  assert.equal(
    propose(
      classificationInput({
        genre: 'Reggaeton',
        title: 'Synthetic 2024 Remix',
        era: { year: 2024, kind: 'version', current: true },
      })
    ).category,
    'Reggaeton New'
  )
  assert.equal(
    propose(
      classificationInput({
        genre: 'Reggaeton',
        era: { year: 2007, kind: 'recording', current: false },
      })
    ).category,
    'Reggaeton'
  )
})

test('conflicting tag/snapshot genres and recording identity stay unresolved; title-only XML matches are not evidence', () => {
  const result = propose(classificationInput({ genres: ['Bachata', 'Merengue'] }))
  assert.equal(result.category, 'Bachata')
  assert.equal(result.status, 'Conflicting Evidence')
  assert.equal(
    propose(
      classificationInput({
        genre: 'Bachata',
        xml: [
          {
            genre: 'Merengue',
            year: '',
            title: 'Synthetic',
            identityConflict: false,
          },
        ],
      })
    ).status,
    'Conflicting Evidence'
  )
  assert.equal(
    propose(
      classificationInput({
        genre: 'Bachata',
        xml: [
          {
            genre: 'Bachata',
            year: '',
            title: 'Other Version',
            identityConflict: true,
          },
        ],
      })
    ).category,
    null
  )
  assert.equal(
    propose(classificationInput({ genre: 'Bachata', xmlOverflow: true })).status,
    'Conflicting Evidence'
  )
})

test('automatic classification persists suggestions, preserves manual/excluded decisions, and acknowledges existing conflicts', async () => {
  const f = await fixture('classification-decisions')
  const classifier = new Classifier(f.db, () => {})
  try {
    for (const name of ['auto', 'manual', 'excluded'])
      await writeFile(path.join(f.root, name + '.wav'), wav({ title: name, genre: 'Bachata' }))
    f.db.addSource(f.root)
    await scan(f.scanner)
    let manual = f.db.list(QUERY).tracks.find(t => t.title === 'manual')!,
      excluded = f.db.list(QUERY).tracks.find(t => t.title === 'excluded')!
    f.db.updateDecision([{ id: manual.id, revision: manual.revision }], 'category', 'Jersey Club')
    f.db.updateDecision([{ id: excluded.id, revision: excluded.revision }], 'review', 'exclude')
    classifier.schedule()
    await classifier.wait()
    const auto = f.db.list(QUERY).tracks.find(t => t.title === 'auto')!
    assert.equal(auto.category, 'Bachata')
    assert.equal(auto.manual, false)
    assert.equal(auto.review, 'Ready for Approval')
    assert.equal(f.db.get(manual.id)?.category, 'Jersey Club')
    assert.equal(classifier.track(manual.id)?.manualConflict, true)
    assert.equal(f.db.get(excluded.id)?.review, 'Excluded')
    manual = f.db.get(manual.id)!
    f.db.updateDecision([{ id: manual.id, revision: manual.revision }], 'category', 'Jersey Club')
    classifier.schedule()
    await classifier.wait()
    assert.equal(classifier.track(manual.id)?.manualConflict, false)
    assert.equal(f.db.get(manual.id)?.review, 'Ready for Approval')
    const decisions = (f.db.db.prepare('SELECT COUNT(*) n FROM decisions').get() as { n: number }).n
    classifier.runNow()
    await classifier.wait()
    assert.equal(
      (
        f.db.db.prepare('SELECT COUNT(*) n FROM decisions').get() as {
          n: number
        }
      ).n,
      decisions
    )
    assert.equal(classifier.state().lastJob?.changed, 0)
    assert.equal(classifier.state().lastJob?.cached, 3)
    assert.equal(f.db.get(auto.id)?.manual, false)
  } finally {
    await classifier.close()
    f.close()
  }
})

test('new evidence creates a persistent conflict without undoing a manual choice; stale confirmations require review', async () => {
  const f = await fixture('classification-new-evidence'),
    classifier = new Classifier(f.db, () => {})
  try {
    const file = path.join(f.root, 'Version.wav')
    await writeFile(file, wav({ genre: 'Reggaeton', year: '2025' }))
    f.db.addSource(f.root)
    await scan(f.scanner)
    classifier.schedule()
    await classifier.wait()
    let track = f.db.list(QUERY).tracks[0]!
    assert.equal(track.category, 'Reggaeton')
    classifier.eraYear({
      id: track.id,
      revision: track.revision,
      year: 2007,
      kind: 'recording',
      note: 'Synthetic original release evidence',
    })
    await classifier.wait()
    track = f.db.get(track.id)!
    assert.equal(track.category, 'Reggaeton Old')
    assert.equal(track.year, 2025)
    classifier.eraYear({
      id: track.id,
      revision: track.revision,
      year: 2007,
      kind: 'recording',
      note: 'Updated synthetic release reference',
    })
    await classifier.wait()
    assert.equal(classifier.track(track.id)?.era?.note, 'Updated synthetic release reference')
    track = f.db.get(track.id)!
    f.db.updateDecision([{ id: track.id, revision: track.revision }], 'category', 'Reggaeton Old')
    await writeFile(file, wav({ genre: 'Merengue', year: '2026' }))
    await scan(f.scanner)
    assert.equal(classifier.track(track.id)?.stale, true)
    classifier.schedule()
    await classifier.wait()
    assert.equal(f.db.get(track.id)?.category, 'Reggaeton Old')
    assert.equal(f.db.get(track.id)?.review, 'File Changed')
    assert.equal(classifier.track(track.id)?.manualConflict, true)
    assert.equal(classifier.track(track.id)?.era?.current, false)
    await writeFile(file, wav({ genre: 'Reggaeton', year: '2026' }))
    await scan(f.scanner)
    classifier.schedule()
    await classifier.wait()
    assert.equal(classifier.track(track.id)?.category, 'Reggaeton')
    assert.equal(classifier.track(track.id)?.status, 'Verify Release Year')
    track = f.db.get(track.id)!
    assert.throws(
      () =>
        classifier.eraYear({
          id: track.id,
          revision: track.revision - 1,
          year: 2008,
          kind: 'version',
          note: '',
        }),
      /changed/
    )
  } finally {
    await classifier.close()
    f.close()
  }
})

test('previewed explicit rules are bounded, literal, revocable, protect manual decisions and reject stale previews', async () => {
  const f = await fixture('classification-rules'),
    classifier = new Classifier(f.db, () => {})
  try {
    for (const name of ['automatic', 'manual'])
      await writeFile(path.join(f.root, name + '.wav'), wav({ title: name, genre: 'Club Music' }))
    f.db.addSource(f.root)
    await scan(f.scanner)
    classifier.schedule()
    await classifier.wait()
    let track = f.db.list(QUERY).tracks.find(t => t.title === 'manual')!
    f.db.updateDecision([{ id: track.id, revision: track.revision }], 'category', 'Hip Hop')
    classifier.schedule()
    await classifier.wait()
    const rule = {
      field: 'genre',
      match: 'Club Music',
      category: 'Jersey Club',
    } as const
    let preview = await classifier.preview(rule)
    assert.equal(preview.affected, 2)
    assert.equal(preview.protected, 1)
    assert.equal(preview.conflicts, 1)
    track = f.db.get(track.id)!
    f.db.updateDecision([{ id: track.id, revision: track.revision }], 'category', 'Pop')
    assert.throws(() => classifier.saveRule(preview.token), /stale/)
    classifier.schedule()
    await classifier.wait()
    preview = await classifier.preview(rule)
    classifier.saveRule(preview.token)
    await classifier.wait()
    assert.equal(
      f.db.list(QUERY).tracks.find(t => t.title === 'automatic')?.category,
      'Jersey Club'
    )
    assert.equal(f.db.get(track.id)?.category, 'Pop')
    const conflicting = await classifier.preview({
      ...rule,
      category: 'Bounce',
    })
    classifier.saveRule(conflicting.token)
    await classifier.wait()
    assert.equal(f.db.list(QUERY).tracks.find(t => t.title === 'automatic')?.category, null)
    assert.equal(
      f.db.list(QUERY).tracks.find(t => t.title === 'automatic')?.review,
      'Conflicting Evidence'
    )
    for (const saved of classifier.rules()) {
      classifier.removeRule(saved.id)
      await classifier.wait()
    }
    assert.equal(f.db.list(QUERY).tracks.find(t => t.title === 'automatic')?.category, null)
    assert.equal(f.db.get(track.id)?.category, 'Pop')
    assert.equal(
      await classifier
        .preview({ field: 'versionLabel', match: '[.*]', category: 'Pop' })
        .catch(() => null),
      null
    )
    assert.throws(() =>
      requestSchemas.classificationRulePreview.parse({
        ...rule,
        category: '_JUNK',
      })
    )
    assert.throws(() =>
      requestSchemas.eraYear.parse({
        id: track.id,
        revision: 1,
        year: 10000,
        kind: 'recording',
        note: '',
      })
    )
    assert.throws(() => requestSchemas.classificationAutomatic.parse('true'))
  } finally {
    await classifier.close()
    f.close()
  }
})

test('classification uses only exact current XML references and refresh can supply/conflict/remove genre evidence', async () => {
  const f = await xmlFixture('classification-xml'),
    classifier = new Classifier(f.db, () => {})
  try {
    const file = path.join(f.root, 'Tone.wav')
    await writeFile(file, wav({ genre: '', title: 'Fixture' }))
    f.db.addSource(f.root)
    await scan(f.scanner)
    const track = f.db.list(QUERY).tracks[0]!
    await chooseImport(
      f,
      rbXML([
        {
          TrackID: '1',
          Location: pathToFileURL(file).href,
          Genre: 'Bachata',
          Name: 'Fixture',
        },
      ])
    )
    classifier.schedule()
    await classifier.wait()
    assert.equal(f.db.get(track.id)?.category, 'Bachata')
    await chooseImport(
      f,
      rbXML([
        {
          TrackID: '1',
          Location: pathToFileURL(file).href,
          Genre: 'Merengue',
          Name: 'Another Recording',
        },
      ])
    )
    classifier.schedule()
    await classifier.wait()
    assert.equal(f.db.get(track.id)?.category, null)
    assert.equal(f.db.get(track.id)?.review, 'Conflicting Evidence')
    await chooseImport(
      f,
      rbXML([
        {
          TrackID: '1',
          Location: pathToFileURL(file).href,
          Genre: 'Bachata',
          Size: '1',
        },
      ])
    )
    classifier.schedule()
    await classifier.wait()
    assert.equal(f.db.get(track.id)?.category, null)
    await chooseImport(f, rbXML([]))
    classifier.schedule()
    await classifier.wait()
    assert.equal(f.db.get(track.id)?.category, null)
  } finally {
    await classifier.close()
    await f.close()
  }
})

test('durable classification queue pauses, resumes across restart, caches unchanged inputs and leaves source bytes unchanged', async () => {
  const f = await fixture('classification-resume')
  let reopened: LibraryDB | null = null
  let classifier = new Classifier(f.db, () => {})
  try {
    const file = path.join(f.root, 'Tone.wav')
    await writeFile(file, wav({ genre: 'Bachata' }))
    f.db.addSource(f.root)
    await scan(f.scanner)
    const before = await hash(file),
      id = f.db.list(QUERY).tracks[0]!.id
    classifier.automatic(false)
    classifier.schedule()
    await classifier.wait()
    assert.equal(classifier.state().pending, 1)
    assert.equal(f.db.get(id)?.category, null)
    await classifier.close()
    const directory = f.db.directory
    f.db.close()
    reopened = new LibraryDB(directory)
    classifier = new Classifier(reopened, () => {})
    assert.equal(classifier.state().automatic, false)
    assert.equal(classifier.state().pending, 1)
    classifier.automatic(true)
    await classifier.wait()
    assert.equal(reopened.get(id)?.category, 'Bachata')
    assert.equal(await hash(file), before)
    classifier.schedule()
    await classifier.wait()
    assert.equal(classifier.state().lastJob?.cached, 1)
    assert.equal(reopened.get(id)?.manual, false)
    assert.equal(reopened.get(id)?.genre, 'Bachata')
  } finally {
    await classifier.close()
    f.helper.close()
    if (reopened) reopened.close()
    else f.db.close()
  }
})

test('schema 2 classification upgrade creates a consistent backup and retains catalog, XML, manual history and paused sources', async () => {
  const f = await xmlFixture('classification-migration')
  try {
    const file = path.join(f.root, 'Tone.wav')
    await writeFile(file, wav({ genre: 'Bachata' }))
    const source = f.db.addSource(f.root)
    await scan(f.scanner)
    const track = f.db.list(QUERY).tracks[0]!
    f.db.updateDecision([{ id: track.id, revision: track.revision }], 'category', 'Pop')
    f.db.sourceEnabled(source.id, false)
    const snapshot = await chooseImport(
      f,
      rbXML([{ TrackID: '1', Location: pathToFileURL(file).href }])
    )
    await f.rb.close()
    f.db.close()
    const old = new Database(path.join(f.rb.directory, '../library.sqlite'))
    old.exec(dropClassificationSchema + 'PRAGMA user_version=2;')
    old.close()
    const upgraded = new LibraryDB(path.join(f.rb.directory, '..'))
    try {
      assert.equal(upgraded.db.pragma('user_version', { simple: true }), 8)
      assert.equal(upgraded.get(track.id)?.category, 'Pop')
      assert.equal(upgraded.sources()[0]?.enabled, false)
      const backupName = (await readdir(upgraded.directory)).find(name =>
        name.startsWith('before-schema-3')
      )!
      const backup = new Database(path.join(upgraded.directory, backupName), {
        readonly: true,
      })
      assert.equal(backup.pragma('user_version', { simple: true }), 2)
      assert.equal(
        (backup.prepare('SELECT id FROM rb_snapshots WHERE active=1').get() as { id: string }).id,
        snapshot.id
      )
      backup.close()
      const classifier = new Classifier(upgraded, () => {})
      classifier.schedule()
      await classifier.wait()
      assert.equal(upgraded.get(track.id)?.category, 'Pop')
      await classifier.close()
    } finally {
      upgraded.close()
    }
  } finally {
    f.helper.close()
  }
})

test('50,000 catalog tracks classify with bounded batches; pause/restart, cache and rule preview stay responsive', async () => {
  const f = await fixture('classification-scale')
  let classifier = new Classifier(f.db, () => {})
  try {
    const source = f.db.addSource(f.root),
      now = new Date().toISOString()
    const insert = f.db.db.prepare(
      "INSERT INTO files(id,physicalKey,path,filename,sourceId,signature,artist,title,genre,size,availability,addedAt,updatedAt,tags) VALUES(?,?,?,?,?,'fixture','Fixture',?, ?,1024,'available',?,?, '{}')"
    )
    f.db.db.transaction(() => {
      for (let i = 0; i < 50000; i++)
        insert.run(
          randomUUID(),
          `scale:${i}`,
          `/generated/${i}.wav`,
          `${i}.wav`,
          source.id,
          `Synthetic ${i}`,
          i % 2 ? 'Bachata' : 'Club Music',
          now,
          now
        )
    })()
    classifier.schedule()
    await new Promise<void>(resolve => setImmediate(resolve))
    classifier.automatic(false)
    await classifier.wait()
    assert.equal(classifier.state().lastJob?.status, 'paused')
    assert.ok(classifier.state().pending > 0)
    await classifier.close()
    classifier = new Classifier(f.db, () => {})
    let ticks = 0
    const timer = setInterval(() => ticks++, 10),
      start = performance.now()
    classifier.automatic(true)
    await classifier.wait()
    const milliseconds = performance.now() - start
    clearInterval(timer)
    assert.equal(classifier.state().pending, 0)
    assert.equal(classifier.state().ready, 25000)
    assert.equal(classifier.state().unresolved, 25000)
    assert.ok(ticks > 10)
    assert.ok(milliseconds < 60000, `Classifier exceeded 60s regression ceiling: ${milliseconds}ms`)
    const first = f.db.list(QUERY).tracks[0]!,
      revision = first.revision
    classifier.schedule()
    await classifier.wait()
    assert.equal(classifier.state().lastJob?.cached, 50000)
    assert.equal(f.db.get(first.id)?.revision, revision)
    const cancelledPreview = classifier.preview({
      field: 'genre',
      match: 'Club Music',
      category: 'Jersey Club',
    })
    classifier.cancelPreview()
    await assert.rejects(cancelledPreview, /cancelled/)
    const preview = await classifier.preview({
      field: 'genre',
      match: 'Club Music',
      category: 'Jersey Club',
    })
    assert.equal(preview.affected, 25000)
    assert.equal(preview.examples.length, 20)
    assert.equal(classifier.rules().length, 0)
    const report = {
      records: 50000,
      resumedProcessingMilliseconds: Number(milliseconds.toFixed(2)),
      eventLoopTimerTicks: ticks,
      batchLimit: 100,
      ready: 25000,
      unresolved: 25000,
      rulePreviewMatches: preview.affected,
      scope: 'Generated stored metadata; not audio genre inference or real-library accuracy',
    }
    await writeFile(
      path.resolve(project, '../../work/classification-benchmark.json'),
      JSON.stringify(report, null, 2)
    )
    console.log('Classification benchmark: ' + JSON.stringify(report))
  } finally {
    await classifier.close()
    f.close()
  }
})

test('failed classifier batch rolls back files and retains queued work for a safe retry', async () => {
  const f = await fixture('classification-fault'),
    classifier = new Classifier(f.db, () => {})
  try {
    await writeFile(path.join(f.root, 'Tone.wav'), wav({ genre: 'Bachata' }))
    f.db.addSource(f.root)
    await scan(f.scanner)
    f.db.db.exec(
      "CREATE TRIGGER reject_classification BEFORE INSERT ON classification_results BEGIN SELECT RAISE(ABORT,'injected classification failure'); END;"
    )
    classifier.schedule()
    await classifier.wait()
    assert.equal(classifier.state().lastJob?.status, 'failed')
    assert.equal(classifier.state().pending, 1)
    assert.equal(f.db.list(QUERY).tracks[0]?.category, null)
    f.db.db.exec('DROP TRIGGER reject_classification;')
    classifier.runNow()
    await classifier.wait()
    assert.equal(classifier.state().lastJob?.status, 'completed')
    assert.equal(f.db.list(QUERY).tracks[0]?.category, 'Bachata')
  } finally {
    await classifier.close()
    f.close()
  }
})

test('approved current research fills categories ahead of broad tags while stale research and identity conflicts remain protected', () => {
  const input = classificationInput({
    genres: ['House', 'Reggaeton', 'Salsa'],
    research: {
      genre: 'Salsa',
      source: 'Synthetic approved research',
      current: true,
    },
  })
  const clear = propose(input)
  assert.equal(clear.category, 'Salsa')
  assert.equal(clear.status, 'Ready for Approval')
  assert.equal(clear.basis, 'approved research')
  assert.ok(clear.evidence.some(e => e.value === 'House'))
  const stale = propose({
    ...input,
    research: { ...input.research!, current: false },
  })
  assert.equal(stale.category, 'Dance')
  assert.equal(stale.status, 'Conflicting Evidence')
  assert.equal(
    propose({
      ...input,
      xml: [
        {
          genre: 'Salsa',
          year: '',
          title: 'Wrong version',
          identityConflict: true,
        },
      ],
    }).category,
    null
  )
  assert.equal(propose({ ...input, title: 'Synthetic Jersey Club Remix' }).category, 'Jersey Club')
  assert.equal(propose({ ...input, partial: true }).category, null)
})

test('best-fit placements keep broad Latin, cross-genre and workflow material browsable without approving them', () => {
  for (const [input, category, status] of [
    [classificationInput({ genre: 'Latin' }), 'Latin Other', 'Needs Review'],
    [classificationInput({ genre: 'Hip-Hop / R&B' }), 'Hip Hop', 'Conflicting Evidence'],
    [classificationInput({ genre: 'R&B / Hip-Hop' }), 'R&B', 'Conflicting Evidence'],
    [classificationInput({ genre: 'Loop Samples' }), '_JUNK', 'Needs Review'],
    [classificationInput({ genre: 'Reggaeton', year: 2024 }), 'Reggaeton', 'Verify Release Year'],
  ] as const) {
    const proposal = propose(input)
    assert.equal(proposal.category, category)
    assert.equal(proposal.status, status)
  }
  for (const [genre, category] of [
    ['K-Pop', 'Pop'],
    ['Bass House', 'Dance'],
    ['Plena fusion', 'Plena'],
    ['Puerto Rican folk / Latin ballad', 'Latin Other'],
  ])
    assert.equal(propose(classificationInput({ genre })).category, category)
  assert.equal(propose(classificationInput({ title: 'Latin Night' })).category, null)
  assert.equal(
    propose(classificationInput({ genre: 'Hip-Hop / R&B', availability: 'missing' })).category,
    null
  )
})

test('exact playlist genre intent places broad tags while playlist disagreements and recording identity remain reviewable', () => {
  const one = propose(classificationInput({ genre: 'Latin', playlists: ['_INBOX', '04 Dembow'] }))
  assert.equal(one.category, 'Dembow')
  assert.equal(one.status, 'Ready for Approval')
  assert.equal(one.basis, 'playlist membership')
  const two = propose(
    classificationInput({
      genre: 'Latin',
      playlists: ['04 Dembow', '06 Bachata Set'],
    })
  )
  assert.equal(two.category, 'Dembow')
  assert.equal(two.status, 'Conflicting Evidence')
  const disagreement = propose(classificationInput({ genre: 'Bachata', playlists: ['04 Dembow'] }))
  assert.equal(disagreement.category, 'Dembow')
  assert.equal(disagreement.status, 'Conflicting Evidence')
  assert.equal(
    propose(classificationInput({ genre: 'Latin', playlists: ['Warmup Openers'] })).status,
    'Needs Review'
  )
  assert.equal(
    propose(
      classificationInput({
        genre: 'Latin',
        playlists: ['02 Reggaeton Clasico'],
      })
    ).category,
    'Reggaeton'
  )
  assert.equal(
    propose(
      classificationInput({
        genre: 'Latin',
        playlists: ['04 Dembow'],
        xml: [
          {
            genre: 'Latin',
            year: '',
            title: 'Another recording',
            identityConflict: true,
          },
        ],
      })
    ).category,
    null
  )
})

test('playlist placement follows active exact-file snapshot membership and ignores title-only associations', async () => {
  const f = await xmlFixture('playlist-placement'),
    classifier = new Classifier(f.db, () => {})
  try {
    const file = path.join(f.root, 'Synthetic.wav')
    await writeFile(file, wav({ title: 'Synthetic', genre: 'Latin' }))
    f.db.addSource(f.root)
    await scan(f.scanner)
    const id = f.db.list(QUERY).tracks[0]!.id
    const playlist =
      '<NODE Type="1" Name="04 Dembow" Entries="1" KeyType="0"><TRACK Key="1"/></NODE>'
    await chooseImport(
      f,
      rbXML(
        [
          {
            TrackID: '1',
            Location: pathToFileURL(file).href,
            Name: 'Synthetic',
            Genre: 'Latin',
          },
        ],
        playlist
      )
    )
    classifier.runNow()
    await classifier.wait()
    assert.equal(f.db.get(id)?.category, 'Dembow')
    assert.equal(f.db.get(id)?.review, 'Ready for Approval')
    await chooseImport(
      f,
      rbXML(
        [
          {
            TrackID: '1',
            Location: 'file:///generated-not-cataloged/Synthetic.wav',
            Name: 'Synthetic',
            Genre: 'Latin',
          },
        ],
        playlist
      )
    )
    classifier.runNow()
    await classifier.wait()
    assert.equal(f.db.get(id)?.category, 'Latin Other')
    assert.equal(f.db.get(id)?.review, 'Needs Review')
  } finally {
    await classifier.close()
    await f.close()
  }
})

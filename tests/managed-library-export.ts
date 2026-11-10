import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sax from 'sax'
import { managedLibraryXML, type ManagedOrganization } from '../src/managed-library-export'
import { managedTrackIDs } from '../src/managed-track-ids'
import type { CatalogFile } from '../src/duplicate-hashes'

const file = (id: string, location: string): CatalogFile => ({
  id,
  path: location,
  physicalKey: id,
  signature: 'synthetic',
  filename: `${id}.wav`,
  title: id,
  artist: 'Synthetic & Artist',
  genre: 'Original genre',
  year: 2020,
  bpm: 100,
  key: null,
  duration: 180,
  format: 'WAV',
  bitrate: 1411000,
  sampleRate: 44100,
  size: 128,
  category: 'Pop',
  review: 'Needs Manual Classification',
  availability: 'available',
  addedAt: '2026-01-01',
  updatedAt: '2026-01-01',
  manual: false,
  metadataError: null,
  revision: 0,
  sourceId: 'synthetic',
  sourceLabel: 'Synthetic library',
  tags: {},
})
const empty = (): ManagedOrganization => ({
  genres: [],
  playlists: [],
  memberships: [],
})
function inspect(xml: string) {
  const parser = sax.parser(true)
  const parents: string[] = []
  const playlists = new Map<string, string[]>()
  const attrs = new Map<string, Record<string, string>>()
  let collection = false
  parser.onopentag = node => {
    const values = node.attributes as Record<string, string>
    if (node.name === 'COLLECTION') collection = true
    if (node.name === 'NODE') {
      parents.push(values.Name!)
      if (values.Type === '1') playlists.set(parents.join(' / '), [])
    }
    if (node.name === 'TRACK' && collection) attrs.set(values.TrackID!, values)
    else if (node.name === 'TRACK') playlists.get(parents.join(' / '))!.push(values.Key!)
  }
  parser.onclosetag = name => {
    if (name === 'NODE') parents.pop()
    if (name === 'COLLECTION') collection = false
  }
  parser.write(xml).close()
  return { playlists, attrs }
}
test('managed XML mirrors multi-genre practice and personal folders while strict playlists retain safe snapshot preparation', () => {
  const a = file('known', '/synthetic/a & one.wav'),
    b = file('held', '/synthetic/b.wav')
  const organization: ManagedOrganization = {
    genres: [
      { fileId: a.id, value: 'Hip-Hop / Rap' },
      { fileId: a.id, value: 'House / Dance' },
    ],
    playlists: [
      { id: 'folder', name: 'Thursday', kind: 'folder', parentId: null },
      { id: 'list', name: 'Warm & Up', kind: 'playlist', parentId: 'folder' },
      { id: 'other', name: 'Favorites', kind: 'playlist', parentId: null },
    ],
    memberships: [
      { playlistId: 'list', fileId: a.id, ordinal: 0 },
      { playlistId: 'list', fileId: b.id, ordinal: 1 },
      { playlistId: 'list', fileId: 'unavailable', ordinal: 2 },
      { playlistId: 'other', fileId: a.id, ordinal: 0 },
    ],
  }
  const reference = {
    attrs: JSON.stringify({
      Name: 'Snapshot known',
      Artist: 'Snapshot artist',
      Genre: 'Snapshot genre',
    }),
    tempo: JSON.stringify([{ Inizio: '0', Bpm: '100' }]),
    cues: JSON.stringify([{ Name: 'Existing cue', Type: '0', Start: '1' }]),
  }
  const result = managedLibraryXML(
    [
      { track: b, ids: [b.id] },
      { track: a, ids: [a.id] },
    ],
    [{ track: a, reference }],
    organization,
    'DJ Library Organizer',
    'synthetic',
    new Map([
      [a.path, '10'],
      [b.path, '20'],
    ])
  )
  const parsed = inspect(result.xml),
    base = 'ROOT / DJ Library Organizer'
  assert.equal(result.practiceTracks, 2)
  assert.deepEqual(parsed.playlists.get(`${base} / Practice Library / All Practice Tracks`), [
    '10',
    '20',
  ])
  for (const genre of ['Hip-Hop / Rap', 'House / Dance'])
    assert.deepEqual(parsed.playlists.get(`${base} / Practice Library / Genres / ${genre}`), ['10'])
  assert.deepEqual(parsed.playlists.get(`${base} / Practice Library / Unsorted`), ['20'])
  assert.deepEqual(
    parsed.playlists.get(`${base} / Practice Library / My Playlists / Thursday / Warm & Up`),
    ['10', '20']
  )
  assert.deepEqual(parsed.playlists.get(`${base} / Practice Library / My Playlists / Favorites`), [
    '10',
  ])
  assert.deepEqual(parsed.playlists.get(`${base} / Prepared playlists / CLUB & PARTY / Pop`), [
    '10',
  ])
  assert.equal(parsed.attrs.get('10')!.Genre, 'Snapshot genre')
  assert.equal(parsed.attrs.get('20')!.Genre, 'Original genre')
  assert.match(result.xml, /POSITION_MARK Name="Existing cue"/)
  assert.doesNotMatch(
    result.xml.match(/<TRACK [^>]*TrackID="20"[^>]*>(.*?)<\/TRACK>/)![1]!,
    /POSITION_MARK|TEMPO/
  )
  assert.equal(
    result.xml,
    managedLibraryXML(
      [
        { track: a, ids: [a.id] },
        { track: b, ids: [b.id] },
      ],
      [{ track: a, reference }],
      organization,
      'DJ Library Organizer',
      'synthetic',
      new Map([
        [a.path, '10'],
        [b.path, '20'],
      ])
    ).xml
  )
})
test('managed XML refuses repeated paths, ambiguous names, orphan folders and invalid numeric IDs', () => {
  const a = file('a', '/synthetic/a.wav')
  const build = (
    organization = empty(),
    practice = [{ track: a, ids: [a.id] }],
    ids = new Map([[a.path, '1']])
  ) => managedLibraryXML(practice, [], organization, 'DJ Library Organizer', 'synthetic', ids)
  assert.throws(
    () =>
      build(empty(), [
        { track: a, ids: [a.id] },
        { track: a, ids: [a.id] },
      ]),
    /repeats a file path/
  )
  assert.throws(
    () =>
      build({
        ...empty(),
        genres: [
          { fileId: a.id, value: 'Other' },
          { fileId: a.id, value: 'other' },
        ],
      }),
    /repeated names/
  )
  assert.throws(
    () =>
      build({
        ...empty(),
        playlists: [
          {
            id: 'one',
            name: 'Missing parent',
            parentId: 'absent',
            kind: 'playlist',
          },
        ],
      }),
    /missing or cyclic/
  )
  assert.throws(
    () =>
      build({
        ...empty(),
        memberships: [{ playlistId: 'absent', fileId: a.id, ordinal: 0 }],
      }),
    /no valid playlist/
  )
  assert.throws(
    () => build(empty(), undefined, new Map([[a.path, '2147483648']])),
    /IDs are missing or invalid/
  )
})
test('managed IDs persist signed-32-bit collision choices, survive reordering and reject changed registry contents', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dj-managed-ids-synthetic-'))
  try {
    const a = path.join(root, 'a.wav'),
      b = path.join(root, 'b.wav'),
      c = path.join(root, 'c.wav')
    const digest = (text: string) => createHash('sha256').update(text).digest('hex')
    const collision = (Number.parseInt(digest(b).slice(0, 8), 16) % 2147483647) + 1
    const registry = path.join(root, 'managed-track-ids.json')
    await writeFile(registry, JSON.stringify({ version: 1, ids: { [digest(a)]: collision } }))
    const first = await managedTrackIDs(root, [a, b], () => {})
    assert.equal(first.get(a), String(collision))
    assert.notEqual(first.get(a), first.get(b))
    for (const id of first.values()) assert.ok(Number(id) > 0 && Number(id) <= 2147483647)
    const next = await managedTrackIDs(root, [c, b, a], () => {})
    assert.equal(first.get(a), next.get(a))
    assert.equal(first.get(b), next.get(b))
    const before = await readFile(registry, 'utf8')
    await assert.rejects(
      managedTrackIDs(root, [path.join(root, 'new.wav')], () => {
        throw new Error('Cancelled')
      }),
      /Cancelled/
    )
    assert.equal(await readFile(registry, 'utf8'), before)
    await writeFile(
      registry,
      JSON.stringify({ version: 1, ids: { [digest(a)]: 1, [digest(b)]: 1 } })
    )
    await assert.rejects(
      managedTrackIDs(root, [a], () => {}),
      /repeated IDs/
    )
    await rm(registry)
    const outside = path.join(root, 'outside.json')
    await writeFile(outside, before)
    await symlink(outside, registry)
    await assert.rejects(managedTrackIDs(root, [a], () => {}))
    assert.equal(await readFile(outside, 'utf8'), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

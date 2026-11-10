import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { LibraryDB } from './db'
import { normalize } from './classification'
import { inputDigest, researchInput } from './research-identity'
import type { Track } from './shared'
import { MUSIC_CATEGORIES, type Category } from './shared'
import {
  ORGANIZATION_GROUPS,
  type Familiarity,
  type LibraryPlaylist,
  type OrganizationChange,
  type OrganizationFamiliarityUpdate,
  type OrganizationGroup,
  type OrganizationResult,
  type OrganizationState,
  type OrganizationTag,
  type OrganizationTagsUpdate,
  type OrganizationTrack,
  type PlaylistCreate,
  type PlaylistMembers,
  type PlaylistRename,
} from './organization-types'

const aliases: [string, string[]][] = [
  ['Hip-Hop / Rap', ['hip hop', 'hiphop', 'rap', 'hip hop rap', 'trap', 'trap hip hop']],
  [
    'R&B',
    ['r&b', 'rnb', 'rhythm and blues', 'contemporary r&b', 'alternative r&b', 'soul', 'neo soul'],
  ],
  ['Reggaeton', ['reggaeton', 'reggaeton old', 'reggaeton new', 'reggaeton clasico', 'neoperreo']],
  ['Dembow', ['dembow', 'dominican dembow']],
  [
    'Jersey Club',
    [
      'jersey club',
      'jersey club old',
      'baltimore club',
      'philly club',
      'philadelphia club',
      'bmore club',
    ],
  ],
  ['NOLA Bounce', ['bounce', 'nola bounce', 'new orleans bounce']],
  [
    'Pop',
    [
      'pop',
      'dance pop',
      'synthpop',
      'synth pop',
      'k pop',
      'latin pop',
      'alternative pop',
      'teen pop',
      'bubblegum pop',
      'electropop',
    ],
  ],
  [
    'House / Dance',
    [
      'house dance',
      'dance',
      'edm',
      'electronic',
      'electronica',
      'house',
      'tech house',
      'deep house',
      'progressive house',
      'techno',
      'trance',
      'electro',
      'disco',
      'nu disco',
      'drum and bass',
      'drum & bass',
      'dnb',
      'dubstep',
      'garage',
      'uk garage',
      'afro house',
      'bass house',
      'electro house',
      'hip house',
      'breakbeat',
    ],
  ],
  ['Bachata', ['bachata']],
  ['Salsa', ['salsa']],
  ['Merengue', ['merengue', 'merengue tipico']],
  ['Latin R&B', ['latin r&b', 'latin rnb', 'r&b latino']],
  [
    'Latin Other',
    [
      'latin other',
      'latin',
      'mambo',
      'cha cha cha',
      'bolero',
      'bomba',
      'jibaro',
      'puerto rican folk',
      'latin ballad',
    ],
  ],
  ['Afrobeats', ['afrobeats', 'afrobeat', 'afro pop', 'afropop']],
  ['Dancehall', ['dancehall', 'reggae', 'reggae fusion']],
  ['Rock', ['rock', 'alternative rock', 'indie rock', 'pop rock', 'pop punk', 'punk rock']],
  ['Cumbia', ['cumbia']],
  ['Plena', ['plena', 'plena fusion']],
]
const genreMap = new Map(
  aliases.flatMap(([genre, names]) => [
    [normalize(genre), genre] as const,
    ...names.map(name => [normalize(name), genre] as const),
  ])
)
function genres(value: string): string[] {
  const exact = genreMap.get(normalize(value))
  return exact
    ? [exact]
    : value
        .split(/\s*[/;,|]\s*/)
        .slice(0, 20)
        .flatMap(part => {
          const mapped = genreMap.get(normalize(part))
          return mapped ? [mapped] : []
        })
}
function text(value: unknown, label: string, max = 80): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error(`${label} must contain 1–${max} characters without control characters.`)
  return value.trim()
}
const tagKey = (tag: Pick<OrganizationTag, 'group' | 'value'>) => `${tag.group}\u0000${tag.value}`
const tagOrder = (a: OrganizationTag, b: OrganizationTag) => tagKey(a).localeCompare(tagKey(b))
const serialize = (tags: OrganizationTag[]) => JSON.stringify(tags.slice().sort(tagOrder))
function categoryForGenre(value: string): Category | null {
  const named =
    (
      {
        'Hip-Hop / Rap': 'Hip Hop',
        'NOLA Bounce': 'Bounce',
        'House / Dance': 'Dance',
      } as Record<string, string>
    )[value] || value
  return MUSIC_CATEGORIES.find(category => category === named) || null
}

/** Local catalogue metadata only: this module never opens or writes audio paths. */
export class Organization {
  private task: Promise<OrganizationResult> | null = null
  private closing = false
  constructor(private library: LibraryDB) {}

  get running(): boolean {
    return this.task !== null
  }

  state(): OrganizationState {
    const counts = this.library.db
      .prepare(
        `SELECT COUNT(*) AS practiceCount,
      COALESCE(SUM(NOT EXISTS(SELECT 1 FROM organization_tags t WHERE t.fileId=f.id AND t.groupName='genre')),0) AS unsortedCount,
      COALESCE(SUM(EXISTS(SELECT 1 FROM organization_tags t WHERE t.fileId=f.id AND t.groupName='genre')),0) AS taggedCount
      FROM files f WHERE f.availability='available'`
      )
      .get() as Pick<OrganizationState, 'practiceCount' | 'unsortedCount' | 'taggedCount'>
    return {
      ...counts,
      pending: (
        this.library.db.prepare('SELECT COUNT(*) n FROM organization_queue').get() as { n: number }
      ).n,
      tags: this.library.db
        .prepare(
          "SELECT t.groupName AS 'group',t.value,COUNT(*) AS count FROM organization_tags t JOIN files f ON f.id=t.fileId WHERE f.availability='available' GROUP BY t.groupName,t.value ORDER BY t.groupName,t.value COLLATE NOCASE"
        )
        .all() as OrganizationState['tags'],
      playlists: this.playlists(),
    }
  }

  private playlists(): LibraryPlaylist[] {
    return this.library.db
      .prepare(
        `WITH RECURSIVE descendants(root,id) AS (
      SELECT id,id FROM library_playlists UNION ALL SELECT d.root,p.id FROM descendants d JOIN library_playlists p ON p.parentId=d.id
    ) SELECT p.id,p.name,p.parentId,p.kind,COUNT(DISTINCT CASE WHEN f.availability NOT IN ('trashed','removed') THEN f.id END) AS count
      FROM library_playlists p LEFT JOIN descendants d ON d.root=p.id
      LEFT JOIN library_playlist_members m ON m.playlistId=d.id LEFT JOIN files f ON f.id=m.fileId
      GROUP BY p.id ORDER BY p.createdAt,p.id`
      )
      .all() as LibraryPlaylist[]
  }

  track(id: string): OrganizationTrack {
    const file = this.library.get(id)
    if (!file || ['trashed', 'removed'].includes(file.availability))
      throw new Error('Track is no longer available in the catalogue.')
    const tags = file.organizationTags || []
    const memberships = new Set(
      (
        this.library.db
          .prepare('SELECT playlistId FROM library_playlist_members WHERE fileId=?')
          .all(id) as { playlistId: string }[]
      ).map(row => row.playlistId)
    )
    return {
      fileId: id,
      tags,
      playlists: this.playlists().filter(playlist => memberships.has(playlist.id)),
      familiarity:
        (tags.find(tag => tag.group === 'familiarity')?.value as Familiarity | undefined) ||
        'unheard',
    }
  }

  organize(): Promise<OrganizationResult> {
    if (this.closing)
      return Promise.resolve({
        processed: 0,
        changed: 0,
        pending: this.state().pending,
      })
    if (this.task) return this.task
    this.task = this.run().finally(() => {
      this.task = null
    })
    return this.task
  }

  private async run(): Promise<OrganizationResult> {
    const result: OrganizationResult = { processed: 0, changed: 0, pending: 0 }
    // Bound each pass to its initial queue. New downloads remain queued for the next pass.
    const count = (
      this.library.db.prepare('SELECT COUNT(*) n FROM organization_queue').get() as { n: number }
    ).n
    if (count > 1000000)
      throw new Error('Automatic tagging is limited to one million catalogue files per pass.')
    while (!this.closing && result.processed < count) {
      const batch = this.library.db
        .prepare('SELECT fileId FROM organization_queue ORDER BY rowid LIMIT ?')
        .all(Math.min(64, count - result.processed)) as { fileId: string }[]
      if (!batch.length) break
      this.library.db.transaction(() => {
        for (const { fileId } of batch) {
          const file = this.library.get(fileId)
          if (file && !['trashed', 'removed'].includes(file.availability)) {
            const proposed = this.infer(file)
            let overrides = this.library.db
              .prepare(
                "SELECT groupName AS 'group',value,action FROM organization_overrides WHERE fileId=?"
              )
              .all(fileId) as {
              group: OrganizationGroup
              value: string
              action: 'add' | 'remove'
            }[]
            const legacyGenre =
              file.manual && file.category && !file.category.startsWith('_')
                ? genres(file.category)[0]
                : undefined
            if (legacyGenre && !overrides.some(entry => entry.group === 'genre')) {
              // Empty values cannot be user tags. This internal removal protects the
              // whole automatic genre group when migrating an existing manual decision.
              this.library.db
                .prepare(
                  "INSERT INTO organization_overrides(fileId,groupName,value,action) VALUES(?,'genre','','remove'),(?,'genre',?,'add')"
                )
                .run(file.id, file.id, legacyGenre)
              overrides = [
                ...overrides,
                { group: 'genre', value: '', action: 'remove' },
                { group: 'genre', value: legacyGenre, action: 'add' },
              ]
            }
            const effective = new Map(proposed.map(tag => [tagKey(tag), tag]))
            const familiar = overrides.find(
              entry => entry.group === 'familiarity' && entry.action === 'add'
            )
            if (familiar)
              for (const [key, tag] of effective)
                if (tag.group === 'familiarity') effective.delete(key)
            for (const entry of overrides) {
              if (!entry.value && entry.action === 'remove') {
                for (const [key, tag] of effective)
                  if (tag.group === entry.group) effective.delete(key)
              }
            }
            for (const entry of overrides) {
              if (!entry.value) continue
              if (entry.action === 'remove') effective.delete(tagKey(entry))
              else
                effective.set(tagKey(entry), {
                  group: entry.group,
                  value: entry.value,
                  origin: 'manual',
                })
            }
            const next = [...effective.values()]
            if (serialize(next) !== serialize(file.organizationTags || [])) {
              this.library.db.prepare('DELETE FROM organization_tags WHERE fileId=?').run(fileId)
              const insert = this.library.db.prepare(
                'INSERT INTO organization_tags(fileId,groupName,value,origin) VALUES(?,?,?,?)'
              )
              for (const tag of next) insert.run(fileId, tag.group, tag.value, tag.origin)
              result.changed++
            }
          }
          this.library.db.prepare('DELETE FROM organization_queue WHERE fileId=?').run(fileId)
          result.processed++
        }
      })()
      await setImmediate()
    }
    result.pending = (
      this.library.db.prepare('SELECT COUNT(*) n FROM organization_queue').get() as { n: number }
    ).n
    return result
  }

  async close(): Promise<void> {
    this.closing = true
    await this.task
  }

  private infer(file: Track): OrganizationTag[] {
    const found = new Map<string, OrganizationTag>()
    const add = (group: OrganizationGroup, value: string) => {
      const tag: OrganizationTag = { group, value, origin: 'automatic' }
      found.set(tagKey(tag), tag)
    }
    let labels = normalize(`${file.title || ''} ${file.filename}`)
    const versionStyles: string[] = []
    const explicitStyles = () => {
      for (const [pattern, genre] of [
        [
          /\b(?:jersey|baltimore|philly|philadelphia|bmore)(?: club)? (?:remix|edit|bootleg|mix|version)\b/,
          'Jersey Club',
        ],
        [/\b(?:nola|new orleans)? ?bounce (?:remix|edit|bootleg|mix|version)\b/, 'NOLA Bounce'],
        [/\breggaeton (?:remix|edit|redrum|re drum|bootleg|mix|version)\b/, 'Reggaeton'],
        [
          /\b(?:bachata|salsa|merengue|dembow|dancehall|house) (?:remix|edit|bootleg|mix|version)\b/,
          '',
        ],
      ] as [RegExp, string][]) {
        const match = labels.match(pattern)
        if (match) {
          if (genre) versionStyles.push(genre)
          else versionStyles.push(...genres(match[0].split(' ')[0]!))
        }
      }
    }
    const metadataGenres = new Set<string>()
    for (const value of [file.genre, ...(Array.isArray(file.tags.genre) ? file.tags.genre : [])]) {
      if (typeof value === 'string') for (const genre of genres(value)) metadataGenres.add(genre)
    }
    const references = this.library.db
      .prepare(
        "SELECT t.attrs,m.conflicts,m.trackKey,m.snapshotId FROM rb_matches m JOIN rb_snapshots s ON s.id=m.snapshotId AND s.active=1 JOIN rb_tracks t ON t.snapshotId=m.snapshotId AND t.trackKey=m.trackKey WHERE m.fileId=? AND m.status='referenced' ORDER BY m.trackKey LIMIT 20"
      )
      .all(file.id) as {
      attrs: string
      conflicts: string
      trackKey: string
      snapshotId: string
    }[]
    for (const reference of references) {
      const conflicts = JSON.parse(reference.conflicts) as string[]
      if (conflicts.some(conflict => /^(Name|Artist|Size|TotalTime):/.test(conflict))) continue
      const attrs = JSON.parse(reference.attrs) as Record<string, string>
      labels += ` ${normalize(attrs.Name || '')}`
      for (const genre of genres(attrs.Genre || '')) metadataGenres.add(genre)
      const names = this.library.db
        .prepare(
          "SELECT n.name FROM rb_memberships m JOIN rb_nodes n ON n.snapshotId=m.snapshotId AND n.id=m.nodeId WHERE m.snapshotId=? AND m.trackKey=? AND n.type='playlist' LIMIT 30"
        )
        .all(reference.snapshotId, reference.trackKey) as { name: string }[]
      for (const { name } of names) {
        // Only explicit genre playlist names, never personal names, guessed artists, or energy claims.
        for (const genre of genres(name.replace(/^\s*\d+[\s._-]+/, ''))) metadataGenres.add(genre)
      }
    }
    explicitStyles()
    for (const genre of versionStyles) add('version', `${genre} version`)
    const approved = this.library.db
      .prepare('SELECT signature,inputHash,value FROM research_approved WHERE fileId=?')
      .get(file.id) as { signature: string; inputHash: string; value: string } | undefined
    const identity = approved ? researchInput(file) : null
    const researchGenre =
      approved &&
      identity &&
      approved.signature === (file as Track & { signature: string }).signature &&
      approved.inputHash === inputDigest(identity)
        ? (
            JSON.parse(approved.value) as {
              candidate?: { genre?: string | null }
            }
          ).candidate?.genre
        : null
    const approvedGenres = researchGenre ? genres(researchGenre) : []
    const savedGenres = file.category && !file.category.startsWith('_') ? genres(file.category) : []
    const namedLatin = new Set([
      'Reggaeton',
      'Dembow',
      'Bachata',
      'Salsa',
      'Merengue',
      'Latin R&B',
      'Cumbia',
      'Plena',
    ])
    const strongerSavedLatin =
      metadataGenres.size === 1 && metadataGenres.has('Latin Other')
        ? savedGenres.filter(genre => namedLatin.has(genre))
        : []
    const preferred = versionStyles.length
      ? versionStyles
      : approvedGenres.length
        ? approvedGenres
        : strongerSavedLatin.length
          ? strongerSavedLatin
          : [...metadataGenres]
    if (!preferred.length && file.category && !file.category.startsWith('_'))
      preferred.push(...genres(file.category))
    // A broad Latin tag adds no useful distinction beside an explicit named Latin style.
    const specificLatin = preferred.some(genre => namedLatin.has(genre))
    for (const genre of preferred)
      if (genre !== 'Latin Other' || !specificLatin) add('genre', genre)
    for (const [pattern, value] of [
      [/\b(?:remix|rmx|bootleg|rework)\b/, 'Remix'],
      [/\b(?:intro|outro|edit|redrum|re drum)\b/, 'Intro / Edit'],
      [/\bacoustic\b/, 'Acoustic'],
      [/\b(?:a cappella|acappella|acapella)\b/, 'A Cappella'],
      [/\binstrumental\b/, 'Instrumental'],
      [/\bclean\b(?! bandit\b)/, 'Clean'],
      [/\b(?:explicit|dirty\b(?! (?:south|heads)\b))\b/, 'Explicit'],
      [
        /\b(?:not full(?: version)?|incomplete|snippet|preview|short (?:edit|version|mix)|(?:hh )?(?:clean|dirty) short)\b/,
        'Short / Incomplete',
      ],
    ] as [RegExp, string][])
      if (pattern.test(labels)) add('version', value)
    if (
      /\b(?:serato|loopmasters|merge fx|one shot|sample pack|scratch beats?|practice beats?|rekordbox demo)\b/.test(
        normalize(`${file.artist || ''} ${labels}`)
      )
    )
      add('use', 'Tools & Samples')
    if (
      file.category === '_MIXES' ||
      ((file.duration || 0) >= 600 &&
        /\b(?:dj mix|podcast|summer mix|party mix|hip hop mix|throwback mix|full mix|live set)\b/.test(
          labels
        )) ||
      ((file.duration || 0) >= 1800 && /\b(?:mix|set)\b/.test(labels))
    )
      add('use', 'Full Mix')
    add('familiarity', 'unheard')
    return [...found.values()]
  }

  private selected(changes: OrganizationChange[]): Track[] {
    if (
      !Array.isArray(changes) ||
      !changes.length ||
      changes.length > 5000 ||
      new Set(changes.map(change => change.id)).size !== changes.length
    )
      throw new Error('Select between 1 and 5,000 distinct tracks.')
    return changes.map(change => {
      const file = this.library.get(change.id)
      if (
        !file ||
        ['trashed', 'removed'].includes(file.availability) ||
        file.revision !== change.revision
      )
        throw new Error('The selection changed. Refresh it before saving. No changes were saved.')
      return file
    })
  }

  tagsUpdate(request: OrganizationTagsUpdate): void {
    if (!ORGANIZATION_GROUPS.includes(request.group) || !['add', 'remove'].includes(request.action))
      throw new Error('Invalid tag update.')
    let value = text(request.value, 'Tag')
    if (request.group === 'genre') value = genreMap.get(normalize(value)) || value
    if (request.group === 'familiarity' && !['unheard', 'learning', 'known'].includes(value))
      throw new Error('Invalid practice familiarity.')
    if (request.group === 'familiarity' && request.action === 'remove') {
      request = { ...request, action: 'add' }
      value = 'unheard'
    }
    this.library.db.transaction(() => {
      const selected = this.selected(request.changes)
      for (const file of selected) {
        if (request.group === 'familiarity' && request.action === 'add') {
          this.library.db
            .prepare("DELETE FROM organization_tags WHERE fileId=? AND groupName='familiarity'")
            .run(file.id)
          this.library.db
            .prepare(
              "DELETE FROM organization_overrides WHERE fileId=? AND groupName='familiarity'"
            )
            .run(file.id)
        }
        this.library.db
          .prepare(
            'INSERT INTO organization_overrides(fileId,groupName,value,action) VALUES(?,?,?,?) ON CONFLICT(fileId,groupName,value) DO UPDATE SET action=excluded.action'
          )
          .run(file.id, request.group, value, request.action)
        if (request.action === 'add')
          this.library.db
            .prepare(
              "INSERT INTO organization_tags(fileId,groupName,value,origin) VALUES(?,?,?,'manual') ON CONFLICT(fileId,groupName,value) DO UPDATE SET origin='manual'"
            )
            .run(file.id, request.group, value)
        else
          this.library.db
            .prepare('DELETE FROM organization_tags WHERE fileId=? AND groupName=? AND value=?')
            .run(file.id, request.group, value)
        if (request.group === 'genre') {
          const remaining = this.library.db
            .prepare(
              "SELECT value FROM organization_tags WHERE fileId=? AND groupName='genre' ORDER BY origin DESC,value"
            )
            .all(file.id) as { value: string }[]
          const nextCategory =
            (request.action === 'add' ? categoryForGenre(value) : null) ||
            remaining.map(tag => categoryForGenre(tag.value)).find(category => category !== null) ||
            null
          this.library.db
            .prepare('UPDATE files SET category=?,manual=1,review=?,revision=revision+1 WHERE id=?')
            .run(
              nextCategory,
              nextCategory ? 'Ready for Approval' : 'Needs Manual Classification',
              file.id
            )
          this.library.db
            .prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?)')
            .run(
              randomUUID(),
              file.id,
              'category',
              file.category || '',
              nextCategory || '',
              new Date().toISOString(),
              file.revision + 1
            )
          this.library.db
            .prepare('UPDATE classification_results SET acknowledgedHash=inputHash WHERE fileId=?')
            .run(file.id)
        }
      }
    })()
  }

  familiarity(request: OrganizationFamiliarityUpdate): void {
    this.tagsUpdate({ ...request, group: 'familiarity', action: 'add' })
  }

  private playlist(id: string): LibraryPlaylist {
    const playlist = this.playlists().find(entry => entry.id === id)
    if (!playlist) throw new Error('Playlist or folder no longer exists.')
    return playlist
  }

  playlistCreate(request: PlaylistCreate): LibraryPlaylist {
    if (request.kind !== 'folder' && request.kind !== 'playlist')
      throw new Error('Invalid playlist type.')
    const name = text(request.name, 'Playlist name', 120),
      parentId = request.parentId || null
    if (this.playlists().length >= 5000)
      throw new Error('The library supports up to 5,000 playlists and folders.')
    if (parentId) {
      if (this.playlist(parentId).kind !== 'folder')
        throw new Error('Playlists can only be created inside folders.')
      const depth = (
        this.library.db
          .prepare(
            'WITH RECURSIVE parents(id,parentId,depth) AS (SELECT id,parentId,1 FROM library_playlists WHERE id=? UNION ALL SELECT p.id,p.parentId,a.depth+1 FROM library_playlists p JOIN parents a ON p.id=a.parentId) SELECT MAX(depth) AS depth FROM parents'
          )
          .get(parentId) as { depth: number }
      ).depth
      if (depth >= 8) throw new Error('Playlist folders can be nested up to eight levels.')
    }
    this.uniqueName(name, parentId)
    const id = randomUUID()
    this.library.db
      .prepare('INSERT INTO library_playlists(id,name,parentId,kind,createdAt) VALUES(?,?,?,?,?)')
      .run(id, name, parentId, request.kind, new Date().toISOString())
    return this.playlist(id)
  }

  private uniqueName(name: string, parentId: string | null, exceptId = '') {
    if (
      this.library.db
        .prepare(
          'SELECT 1 FROM library_playlists WHERE parentId IS ? AND name=? COLLATE NOCASE AND id!=?'
        )
        .get(parentId, name, exceptId)
    )
      throw new Error('A playlist or folder with that name already exists here.')
  }

  playlistRename(request: PlaylistRename): void {
    const playlist = this.playlist(request.id),
      name = text(request.name, 'Playlist name', 120)
    this.uniqueName(name, playlist.parentId, playlist.id)
    this.library.db.prepare('UPDATE library_playlists SET name=? WHERE id=?').run(name, playlist.id)
  }

  playlistDelete(id: string): void {
    this.playlist(id)
    // Cascades remove child lists and memberships, never catalogue records or audio.
    this.library.db.prepare('DELETE FROM library_playlists WHERE id=?').run(id)
  }

  playlistMembers(request: PlaylistMembers): void {
    if (this.playlist(request.id).kind !== 'playlist')
      throw new Error('Add tracks to a playlist inside the folder.')
    if (
      !['add', 'remove'].includes(request.action) ||
      !Array.isArray(request.ids) ||
      !request.ids.length ||
      request.ids.length > 5000 ||
      new Set(request.ids).size !== request.ids.length
    )
      throw new Error('Select between 1 and 5,000 distinct tracks.')
    this.library.db.transaction(() => {
      let ordinal = (
        this.library.db
          .prepare(
            'SELECT COALESCE(MAX(ordinal),-1)+1 AS n FROM library_playlist_members WHERE playlistId=?'
          )
          .get(request.id) as { n: number }
      ).n
      for (const id of request.ids) {
        const file = this.library.get(id)
        if (!file || ['trashed', 'removed'].includes(file.availability))
          throw new Error(
            'A selected track is no longer available. No playlist changes were saved.'
          )
        if (request.action === 'add')
          this.library.db
            .prepare(
              'INSERT OR IGNORE INTO library_playlist_members(playlistId,fileId,ordinal) VALUES(?,?,?)'
            )
            .run(request.id, id, ordinal++)
        else
          this.library.db
            .prepare('DELETE FROM library_playlist_members WHERE playlistId=? AND fileId=?')
            .run(request.id, id)
      }
    })()
  }
}

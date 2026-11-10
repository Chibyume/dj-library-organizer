import path from 'node:path'
import type { LibraryDB } from './db'
import type { CatalogFile } from './duplicate-hashes'
import type { LibraryPlaylist } from './organization-types'
import { escapeXML, exportTrackXML, type ExportTrack } from './playlist-export'
import { CATEGORY_GROUPS } from './shared'
import { XML_LIMITS } from './xml-schema'

export interface ManagedPracticeTrack {
  track: CatalogFile
  // Multiple current catalogue aliases can refer to the same validated path.
  ids: string[]
}
export interface ManagedOrganization {
  genres: { fileId: string; value: string }[]
  playlists: Pick<LibraryPlaylist, 'id' | 'parentId' | 'name' | 'kind'>[]
  memberships: { playlistId: string; fileId: string; ordinal: number }[]
}
export function managedOrganization(db: LibraryDB): ManagedOrganization {
  const limited = (sql: string, limit: number) => {
    const rows = db.db.prepare(`${sql} LIMIT ?`).all(limit + 1)
    if (rows.length > limit) throw new Error('Practice playlists exceed the managed export limit.')
    return rows
  }
  return {
    genres: limited(
      "SELECT fileId,value FROM organization_tags WHERE groupName='genre' ORDER BY fileId,value",
      XML_LIMITS.memberships
    ) as ManagedOrganization['genres'],
    playlists: limited(
      'SELECT id,parentId,name,kind FROM library_playlists ORDER BY id',
      5000
    ) as ManagedOrganization['playlists'],
    memberships: limited(
      'SELECT playlistId,fileId,ordinal FROM library_playlist_members ORDER BY playlistId,ordinal,fileId',
      XML_LIMITS.memberships
    ) as ManagedOrganization['memberships'],
  }
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
export const managedPath = (file: string) => path.normalize(file)

/** Builds playlist membership only. Local tags never replace embedded/XML Genre. */
export function managedLibraryXML(
  practice: ManagedPracticeTrack[],
  prepared: ExportTrack[],
  organization: ManagedOrganization,
  namespace: string,
  version: string,
  ids: Map<string, string>
) {
  if (practice.length > 100000)
    throw new Error('Managed export supports up to 100,000 available files.')
  const paths = new Map<string, ManagedPracticeTrack>()
  const filePaths = new Map<string, string>()
  for (const entry of practice) {
    const key = managedPath(entry.track.path)
    if (paths.has(key)) throw new Error('A practice export repeats a file path.')
    if (!path.isAbsolute(key) || /[\r\n\0]/.test(key))
      throw new Error('A practice file path cannot be represented safely.')
    paths.set(key, entry)
    for (const id of entry.ids) filePaths.set(id, key)
  }
  const preparedByPath = new Map<string, ExportTrack>()
  for (const entry of prepared) {
    const key = managedPath(entry.track.path)
    if (!paths.has(key) || preparedByPath.has(key))
      throw new Error('Prepared playlist paths do not match the fresh library.')
    preparedByPath.set(key, entry)
  }
  const ordered = [...paths].sort(([a], [b]) => compare(a, b))
  const seenIds = new Set<string>()
  for (const [key] of ordered) {
    const id = ids.get(key)
    if (!id || !/^[0-9]+$/.test(id) || Number(id) < 1 || Number(id) > 2147483647 || seenIds.has(id))
      throw new Error('Managed playlist track IDs are missing or invalid.')
    seenIds.add(id)
  }
  let nodes = 0,
    memberships = 0,
    practicePlaylists = 0
  const folder = (name: string, children: string[]) => {
    if (++nodes > XML_LIMITS.nodes)
      throw new Error('Managed export exceeds the playlist node limit.')
    return `<NODE Type="0" Name="${escapeXML(name)}" Count="${children.length}">${children.join('')}</NODE>`
  }
  const playlist = (name: string, keys: string[], isPractice = true) => {
    if (++nodes > XML_LIMITS.nodes)
      throw new Error('Managed export exceeds the playlist node limit.')
    const unique = [...new Set(keys)]
    memberships += unique.length
    if (memberships > XML_LIMITS.memberships)
      throw new Error('Managed export exceeds the playlist membership limit.')
    if (isPractice) practicePlaylists++
    return `<NODE Type="1" Name="${escapeXML(name)}" KeyType="0" Entries="${unique.length}">${unique.map(key => `<TRACK Key="${ids.get(key)!}"/>`).join('')}</NODE>`
  }
  const genres = new Map<string, Set<string>>(),
    tagged = new Set<string>()
  for (const tag of organization.genres) {
    const key = filePaths.get(tag.fileId)
    if (!key) continue
    const members = genres.get(tag.value) || new Set<string>()
    members.add(key)
    genres.set(tag.value, members)
    tagged.add(key)
  }
  const uniqueNames = (names: string[], label: string) => {
    const normalized = names.map(name => name.normalize('NFKC').toLowerCase())
    if (new Set(normalized).size !== normalized.length)
      throw new Error(`${label} have repeated names. Rename them before syncing.`)
  }
  uniqueNames([...genres.keys()], 'Genre playlists')
  const genreNodes = [...genres]
    .sort(([a], [b]) => compare(a, b))
    .map(([name, keys]) => playlist(name, [...keys].sort(compare)))
  const memberPaths = new Map<string, string[]>()
  const personalById = new Map(organization.playlists.map(list => [list.id, list]))
  for (const member of organization.memberships) {
    if (personalById.get(member.playlistId)?.kind !== 'playlist')
      throw new Error('A personal membership has no valid playlist.')
    const key = filePaths.get(member.fileId)
    if (!key) continue
    const entries = memberPaths.get(member.playlistId) || []
    entries.push(key)
    memberPaths.set(member.playlistId, entries)
  }
  const children = new Map<string | null, ManagedOrganization['playlists']>()
  const seenPlaylists = new Set<string>()
  for (const list of organization.playlists) {
    const entries = children.get(list.parentId) || []
    entries.push(list)
    children.set(list.parentId, entries)
  }
  const personal = (parent: string | null, depth = 0): string[] => {
    if (depth > 20) throw new Error('Personal playlist nesting is too deep.')
    const siblings = children.get(parent) || []
    uniqueNames(
      siblings.map(list => list.name),
      'Personal playlists in one folder'
    )
    return siblings
      .slice()
      .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
      .map(list => {
        if (seenPlaylists.has(list.id))
          throw new Error('Personal playlist folders contain a cycle.')
        seenPlaylists.add(list.id)
        if (list.kind === 'folder') return folder(list.name, personal(list.id, depth + 1))
        if (children.has(list.id)) throw new Error('A playlist cannot contain child playlists.')
        return playlist(list.name, memberPaths.get(list.id) || [])
      })
  }
  const personalNodes = personal(null)
  if (seenPlaylists.size !== organization.playlists.length)
    throw new Error('A personal playlist folder is missing or cyclic.')
  const practiceNode = folder('Practice Library', [
    playlist(
      'All Practice Tracks',
      ordered.map(([key]) => key)
    ),
    folder('Genres', genreNodes),
    playlist(
      'Unsorted',
      ordered.filter(([key]) => !tagged.has(key)).map(([key]) => key)
    ),
    folder('My Playlists', personalNodes),
  ])
  const preparedGroups: string[] = []
  for (const [group, categories] of Object.entries(CATEGORY_GROUPS)) {
    if (group === 'WORKFLOW') continue
    const lists = categories.flatMap(category => {
      const keys = [...preparedByPath]
        .filter(([, entry]) => entry.track.category === category)
        .map(([key]) => key)
        .sort(compare)
      return keys.length ? [playlist(category, keys, false)] : []
    })
    if (lists.length) preparedGroups.push(folder(group, lists))
  }
  const tree = folder('ROOT', [
    folder(namespace, [practiceNode, folder('Prepared playlists', preparedGroups)]),
  ])
  let bytes = Buffer.byteLength(tree)
  const collection = ordered.map(([key, entry]) => {
    const track = exportTrackXML(
      // Practice-only/held entries have no inferred snapshot preparation.
      preparedByPath.get(key) || { track: entry.track, reference: null },
      ids.get(key)!
    )
    bytes += Buffer.byteLength(track)
    if (bytes > 128 * 1024 * 1024) throw new Error('Managed XML exceeds the 128 MB export limit.')
    return track
  })
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<DJ_PLAYLISTS Version="1.0.0"><PRODUCT Name="DJ Library Organizer" Version="${escapeXML(version)}" Company="Local"/><COLLECTION Entries="${ordered.length}">${collection.join('')}</COLLECTION><PLAYLISTS>${tree}</PLAYLISTS></DJ_PLAYLISTS>\n`
  if (Buffer.byteLength(xml) > 128 * 1024 * 1024)
    throw new Error('Managed XML exceeds the 128 MB export limit.')
  return { xml, practiceTracks: ordered.length, practicePlaylists }
}

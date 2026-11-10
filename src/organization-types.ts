export const ORGANIZATION_GROUPS = ['genre', 'version', 'use', 'familiarity'] as const
export type OrganizationGroup = (typeof ORGANIZATION_GROUPS)[number]
export type Familiarity = 'unheard' | 'learning' | 'known'
export const PRACTICE_GENRES = [
  'Hip-Hop / Rap',
  'R&B',
  'Reggaeton',
  'Dembow',
  'Jersey Club',
  'NOLA Bounce',
  'Pop',
  'House / Dance',
  'Bachata',
  'Salsa',
  'Merengue',
  'Latin R&B',
  'Latin Other',
  'Afrobeats',
  'Dancehall',
  'Rock',
  'Cumbia',
  'Plena',
] as const
export interface OrganizationTag {
  group: OrganizationGroup
  value: string
  origin: 'automatic' | 'manual'
}
export interface LibraryPlaylist {
  id: string
  name: string
  parentId: string | null
  kind: 'folder' | 'playlist'
  count: number
}
export interface OrganizationState {
  tags: { group: OrganizationGroup; value: string; count: number }[]
  playlists: LibraryPlaylist[]
  practiceCount: number
  unsortedCount: number
  taggedCount: number
  pending: number
}
export interface OrganizationTrack {
  fileId: string
  tags: OrganizationTag[]
  playlists: LibraryPlaylist[]
  familiarity: Familiarity
}
export interface OrganizationResult {
  processed: number
  changed: number
  pending: number
}
export interface OrganizationChange {
  id: string
  revision: number
}
export interface OrganizationTagsUpdate {
  changes: OrganizationChange[]
  group: OrganizationGroup
  value: string
  action: 'add' | 'remove'
}
export interface OrganizationFamiliarityUpdate {
  changes: OrganizationChange[]
  value: Familiarity
}
export interface PlaylistCreate {
  name: string
  parentId?: string | null
  kind: 'folder' | 'playlist'
}
export interface PlaylistRename {
  id: string
  name: string
}
export interface PlaylistMembers {
  id: string
  ids: string[]
  action: 'add' | 'remove'
}

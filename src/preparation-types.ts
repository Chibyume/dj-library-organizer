import type { Category, Track } from './shared'
export interface DuplicateJob {
  status: 'running' | 'completed' | 'paused' | 'interrupted' | 'failed'
  checked: number
  cached: number
  failed: number
  total: number
  current: string
  error: string | null
}
export interface DuplicateMember {
  track: Pick<
    Track,
    | 'id'
    | 'title'
    | 'artist'
    | 'filename'
    | 'path'
    | 'duration'
    | 'format'
    | 'bitrate'
    | 'sampleRate'
    | 'category'
    | 'review'
  >
  references: number
  playlistReferences?: number
  cues: number
  grids: number
  hash: string | null
}
export interface DuplicateGroup {
  key: string
  fingerprint: string
  kind: 'exact' | 'candidate'
  members: DuplicateMember[]
  memberCount: number
  resolved: boolean
  keeper: string | null
  recommendation: string | null
}
export interface DuplicatePage {
  groups: DuplicateGroup[]
  total: number
  unresolved: number
  unchecked: number
  job: DuplicateJob | null
}
export interface PreparationRequest {
  scope: 'all' | 'selected'
  ids: string[]
}
export interface PreparationItem {
  id: string
  title: string
  artist: string
  path: string
  category: Category | null
  catalogCategory: Category | null
  notes: string[]
  reason: string | null
  approved: boolean
  known: boolean
}
export interface PreparationPreview {
  token: string
  total: number
  eligible: number
  approved: number
  needsApproval: number
  blocked: number
  reasons: Record<string, number>
  categories: Record<string, number>
  known: number
  newToSnapshot: number
  snapshotAt: string | null
}
export interface PreparationPage {
  items: PreparationItem[]
  total: number
}
export interface ExportRecord {
  completedAt?: string
  verification?: ExportVerification
  id: string
  createdAt: string
  directory: string
  namespace: string
  tracks: number
  status: 'writing' | 'exported' | 'failed'
  error: string | null
  reportedImportedAt: string | null
}

export interface PlaylistVerification {
  category: string
  group: string
  status: 'matched' | 'differences' | 'missing-playlist' | 'ambiguous-playlist'
  expected: number
  matched: number
  missing: number
  ambiguous: number
  extra: number
  unresolved: number
  duplicateEntries: number
  examples: { kind: 'missing' | 'ambiguous' | 'extra'; path: string }[]
}
export interface ExportVerification {
  checkedAt: string
  snapshot: {
    id: string
    hash: string
    importedAt: string
    modifiedAt: string
    sourcePath: string
    product: string
  } | null
  status: 'matched' | 'differences' | 'inconclusive'
  current: boolean
  message: string
  expected: number
  matched: number
  playlists: PlaylistVerification[]
  unexpectedPlaylists: number
  unexpectedExamples: string[]
}

export interface AutoCopyResult {
  exactGroups: number
  candidateGroups: number
  versionsKept: number
  preservedChoices: number
}
export interface CleanupOptions {
  includeReferenced: boolean
}
export interface CleanupPreview {
  includeReferenced: boolean
  referencedExtras: number
  token: string
  files: number
  bytes: number
  protected: Record<string, number>
  examples: { title: string; path: string; keeper: string }[]
}
export interface CleanupState {
  id: string
  status: 'running' | 'completed' | 'paused' | 'interrupted' | 'failed' | 'restoring' | 'restored'
  total: number
  trashed: number
  restored: number
  failed: number
  bytes: number
  current: string
  error: string | null
}

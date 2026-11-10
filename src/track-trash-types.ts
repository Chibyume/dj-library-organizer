export interface TrackTrashChange {
  id: string
  revision: number
}

export interface TrackTrashFile {
  id: string
  title: string
  artist: string | null
  path: string
  size: number
  rekordboxReferences: number
  exportReferences: number
  action?: 'move-to-trash' | 'remove-from-library'
  reason?: string
}

export interface TrackTrashPreview {
  scope?: 'selected' | 'junk'
  total?: number
  token: string
  expiresAt: string
  files: TrackTrashFile[]
  bytes: number
  rekordboxReferences: number
  exportReferences: number
  snapshotImportedAt: string | null
  catalogOnly: number
}

export type TrackTrashStatus =
  'running' | 'restoring' | 'completed' | 'partial' | 'interrupted' | 'restored'

export interface TrackTrashRecord {
  id: string
  createdAt: string
  status: TrackTrashStatus
  selected: number
  moved: number
  removed: number
  restored: number
  failed: number
  uncertain: number
  bytes: number
  error: string | null
}

export interface TrackTrashResult extends TrackTrashRecord {
  files: (TrackTrashFile & {
    status:
      | 'pending'
      | 'moving'
      | 'trashed'
      | 'restoring'
      | 'restored'
      | 'failed'
      | 'removed'
      | 'uncertain'
    trashPath?: string
    error?: string
    locationState?: 'original-kept' | 'unconfirmed'
  })[]
}

export interface TrashLibraryInfo {
  state: 'in-trash' | 'original-kept' | 'unconfirmed'
  removedAt: string
  originalPath: string
  trashPath?: string
  reason?: string
  batchId?: string
  origin: 'selected' | 'duplicate' | 'catalog'
}

export interface TrashRestoreResult {
  restored: number
  failed: number
  errors: { id: string; message: string }[]
}

export interface TrashJournalEntry {
  id: string
  path: string
  signature: string
  physicalKey: string
  batchId: string
  removedAt: string
  status: string
  trashPath?: string
  reason?: string
  locationState?: 'original-kept' | 'unconfirmed'
}

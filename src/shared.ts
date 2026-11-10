import type {
  OrganizationState,
  OrganizationTrack,
  OrganizationResult,
  OrganizationTag,
  OrganizationTagsUpdate,
  OrganizationFamiliarityUpdate,
  PlaylistCreate,
  PlaylistRename,
  PlaylistMembers,
  LibraryPlaylist,
} from './organization-types'
import { ORGANIZATION_GROUPS } from './organization-types'
import type {
  TrackTrashPreview,
  TrackTrashResult,
  TrackTrashRecord,
  TrashLibraryInfo,
  TrashRestoreResult,
} from './track-trash-types'
import type { LibraryReviewOverview } from './library-review-types'
import type { AutomationOptions, AutomationState } from './automation-types'
import type {
  AutoCopyResult,
  CleanupPreview,
  CleanupState,
  DuplicateMember,
  DuplicateJob,
  DuplicatePage,
  PreparationRequest,
  PreparationPreview,
  PreparationPage,
  ExportRecord,
} from './preparation-types'
import { z } from 'zod'

export const MUSIC_CATEGORIES = [
  'Dembow',
  'Merengue',
  'Salsa',
  'Cumbia',
  'Plena',
  'Bachata',
  'Reggaeton',
  'Reggaeton Old',
  'Reggaeton New',
  'Latin R&B',
  'Latin Other',
  'Jersey Club',
  'Bounce',
  'Hip Hop',
  'R&B',
  'Pop',
  'Dance',
  'Afrobeats',
  'Dancehall',
  'Rock',
] as const
export const CATEGORIES = [
  ...MUSIC_CATEGORIES,
  '_INBOX',
  '_REVIEW',
  '_DUPES',
  '_MIXES',
  '_JUNK',
] as const
export const CATEGORY_GROUPS = {
  LATIN: [
    'Dembow',
    'Merengue',
    'Salsa',
    'Cumbia',
    'Plena',
    'Bachata',
    'Reggaeton',
    'Reggaeton Old',
    'Reggaeton New',
    'Latin R&B',
    'Latin Other',
  ],
  'CLUB & PARTY': ['Jersey Club', 'Bounce', 'Pop', 'Dance', 'Afrobeats', 'Dancehall', 'Rock'],
  'HIP HOP & R&B': ['Hip Hop', 'R&B'],
  WORKFLOW: CATEGORIES.filter(c => c.startsWith('_')),
}
export type Category = (typeof CATEGORIES)[number]
export type Availability =
  | 'available'
  | 'cloud-only'
  | 'unavailable'
  | 'missing'
  | 'trashed'
  | 'removed'
  | 'corrupt'
  | 'unsupported'
  | 'changed'
export interface Track {
  trash?: TrashLibraryInfo
  organizationTags?: OrganizationTag[]
  preparationReason?: string | null
  preparationApproved?: boolean
  id: string
  path: string
  filename: string
  artist: string | null
  title: string | null
  bpm: number | null
  year: number | null
  genre: string | null
  duration: number | null
  format: string | null
  bitrate: number | null
  sampleRate: number | null
  key: string | null
  size: number
  category: Category | null
  review: string
  availability: Availability
  addedAt: string
  updatedAt: string
  manual: boolean
  metadataError: string | null
  revision: number
  sourceId: string
  sourceLabel: string
  tags: Record<string, unknown>
}
export interface Source {
  id: string
  path: string
  label: string
  lastScan: string | null
  fileCount: number
  status: string
  demo: boolean
  broad: boolean
  enabled: boolean
}
export interface ScanIssue {
  path: string
  reason: string
}
export interface ScanProgress {
  incremental?: boolean
  id: string
  kind: 'discovery' | 'smart'
  status: 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed'
  visited: number
  audio: number
  newFiles: number
  changed: number
  unchanged: number
  skipped: number
  bytes: number
  currentPath: string
  startedAt: string
  finishedAt: string | null
  sourceIds?: string[]
  incompleteSourceIds?: string[]
  issues: ScanIssue[]
  coverage: 'in-progress' | 'complete' | 'partial'
}
export interface Summary {
  files: number
  trash: number
  classified: number
  review: number
  unavailable: number
  bytes: number
  lastScan: ScanProgress | null
  categoryCounts: Partial<Record<Category, number>>
}
export interface LibraryQuery {
  search: string
  view:
    | 'all'
    | 'new'
    | 'review'
    | 'unavailable'
    | 'source'
    | 'category'
    | 'practice'
    | 'tag'
    | 'playlist'
    | 'trash'
  value?: string
  sort: string
  direction: 'asc' | 'desc'
  offset: number
  limit: number
}
export interface LibraryPage {
  tracks: Track[]
  total: number
}
export interface Playback {
  fileId: string | null
  playing: boolean
  position: number
  duration: number
  volume: number
  error: string | null
}
export interface OrganizerAPI {
  organizationState(): Promise<OrganizationState>
  organizationRun(): Promise<OrganizationResult>
  organizationTrack(id: string): Promise<OrganizationTrack>
  organizationTagsUpdate(args: OrganizationTagsUpdate): Promise<void>
  organizationFamiliarity(args: OrganizationFamiliarityUpdate): Promise<void>
  playlistCreate(args: PlaylistCreate): Promise<LibraryPlaylist>
  playlistRename(args: PlaylistRename): Promise<void>
  playlistDelete(id: string): Promise<void>
  playlistMembers(args: PlaylistMembers): Promise<void>
  playlistExport(
    id: string | { view: 'practice' | 'tag'; value?: string }
  ): Promise<{ path: string; tracks: number } | null>
  libraryReviewOverview(): Promise<LibraryReviewOverview>
  trackTrashPreview(changes: { id: string; revision: number }[]): Promise<TrackTrashPreview>
  trackTrashPreviewJunk(): Promise<TrackTrashPreview>
  trackTrashStart(token: string): Promise<TrackTrashResult>
  trackTrashHistory(): Promise<TrackTrashRecord[]>
  trackTrashRestore(id: string): Promise<TrackTrashResult>
  trashRestoreFiles(changes: { id: string; revision: number }[]): Promise<TrashRestoreResult>

  automationState(): Promise<AutomationState>
  automationConfigure(options: AutomationOptions): Promise<AutomationState>
  automationFolder(): Promise<AutomationState | null>
  automationCheck(): Promise<void>
  automationReveal(): Promise<void>

  runtimeSecurity: { sandbox: boolean; contextIsolation: boolean }
  duplicateMembers(key: string, fingerprint: string, offset: number): Promise<DuplicateMember[]>
  duplicateAutoChoose(options?: { replaceExisting: boolean }): Promise<AutoCopyResult>
  cleanupPreview(options?: { includeReferenced: boolean }): Promise<CleanupPreview>
  cleanupStart(token: string): Promise<void>
  cleanupState(): Promise<CleanupState | null>
  cleanupHistory(): Promise<
    {
      id: string
      createdAt: string
      trashed: number
      restored: number
      status: CleanupState['status']
    }[]
  >
  cleanupPause(): Promise<void>
  cleanupRestore(id: string): Promise<void>
  duplicateState(): Promise<DuplicateJob | null>
  duplicateRun(): Promise<void>
  duplicatePause(): Promise<void>
  duplicateList(offset: number): Promise<DuplicatePage>
  duplicateResolve(key: string, fingerprint: string, keeper: string | null): Promise<void>
  preparationPreview(request: PreparationRequest): Promise<PreparationPreview>
  preparationPage(
    token: string,
    offset: number,
    filter: 'all' | 'eligible' | 'blocked',
    reason?: string
  ): Promise<PreparationPage>
  preparationClassify(request: {
    token: string
    ids: string[]
    category: (typeof MUSIC_CATEGORIES)[number] | null
  }): Promise<PreparationPreview>
  preparationApprove(token: string): Promise<void>
  preparationCancel(): Promise<void>
  preparationExport(token: string): Promise<ExportRecord | null>
  preparationHistory(): Promise<ExportRecord[]>
  preparationImported(id: string): Promise<void>
  preparationVerify(id: string): Promise<ExportRecord>
  preparationReveal(id: string): Promise<void>
  summary(): Promise<Summary>
  sources(): Promise<Source[]>
  list(query: LibraryQuery): Promise<LibraryPage>
  discover(): Promise<boolean>
  addSource(): Promise<boolean>
  demo(): Promise<boolean>
  scan(kind: 'smart' | 'discovery'): Promise<boolean>
  cancelScan(): Promise<void>
  sourceEnabled(id: string, enabled: boolean): Promise<void>
  xmlChoose(kind: 'file' | 'folder' | 'refresh'): Promise<XMLCandidates>
  xmlDrop(files: File[]): Promise<XMLCandidates>
  xmlImport(id: string): Promise<XMLSummary>
  xmlCancel(): Promise<void>
  xmlSummary(): Promise<XMLSummary | null>
  xmlList(query: XMLQuery): Promise<XMLPage>
  xmlTrack(id: string): Promise<XMLTrackEvidence>
  researchImportChoose(): Promise<ResearchImportPreview | null>
  researchImportApply(token: string): Promise<{ imported: number }>
  researchState(): Promise<ResearchState>
  researchPreview(request: ResearchRequest): Promise<ResearchPreview>
  researchStart(token: string): Promise<void>
  researchPause(): Promise<void>
  researchTrack(id: string): Promise<ResearchEvidence>
  researchAccept(id: string, revision: number, resultId: string, candidate: number): Promise<void>
  researchClear(id: string, revision: number): Promise<void>
  researchSource(id: string, resultId: string, url: string): Promise<void>
  classificationState(): Promise<ClassificationState>
  classificationRun(): Promise<void>
  classificationAutomatic(enabled: boolean): Promise<void>
  classificationTrack(id: string): Promise<ClassificationEvidence | null>
  classificationRules(): Promise<ClassificationRule[]>
  classificationRulePreview(rule: RuleDraft): Promise<RulePreview>
  classificationRuleCancel(): Promise<void>
  classificationRuleSave(token: string): Promise<void>
  classificationRuleRemove(id: string): Promise<void>
  eraYear(
    id: string,
    revision: number,
    year: number | null,
    kind: 'recording' | 'version',
    note: string
  ): Promise<void>
  classify(changes: { id: string; revision: number }[], category: Category | null): Promise<void>
  review(changes: { id: string; revision: number }[], action: 'review' | 'exclude'): Promise<void>
  reveal(id: string): Promise<void>
  playback(
    action: 'load' | 'play' | 'pause' | 'seek' | 'volume' | 'status',
    id?: string,
    value?: number
  ): Promise<Playback>
  onChange(
    fn: (event: {
      kind: string
      progress?: ScanProgress
      xmlProgress?: XMLProgress
      classificationProgress?: ClassificationJob
    }) => void
  ): () => void
}
declare global {
  interface Window {
    organizer: OrganizerAPI
  }
}
const id = z.string().uuid()
export const querySchema = z
  .object({
    search: z.string().max(300),
    view: z.enum([
      'all',
      'new',
      'review',
      'unavailable',
      'source',
      'category',
      'practice',
      'tag',
      'playlist',
      'trash',
    ]),
    value: z.string().max(300).optional(),
    sort: z.enum([
      'artist',
      'title',
      'bpm',
      'year',
      'genre',
      'category',
      'review',
      'duration',
      'filename',
      'availability',
      'addedAt',
    ]),
    direction: z.enum(['asc', 'desc']),
    offset: z.number().int().min(0).max(1000000),
    limit: z.number().int().min(1).max(1000),
  })
  .strict()
export const changesSchema = z
  .array(z.object({ id, revision: z.number().int().min(0) }).strict())
  .min(1)
  .max(1000)
export const requestSchemas = {
  organizationState: z.undefined(),
  organizationRun: z.undefined(),
  organizationTrack: id,
  organizationTagsUpdate: z
    .object({
      changes: changesSchema,
      group: z.enum(ORGANIZATION_GROUPS),
      value: z.string().trim().min(1).max(80),
      action: z.enum(['add', 'remove']),
    })
    .strict(),
  organizationFamiliarity: z
    .object({
      changes: changesSchema,
      value: z.enum(['unheard', 'learning', 'known']),
    })
    .strict(),
  playlistCreate: z
    .object({
      name: z.string().trim().min(1).max(120),
      parentId: id.nullable().optional(),
      kind: z.enum(['folder', 'playlist']),
    })
    .strict(),
  playlistRename: z.object({ id, name: z.string().trim().min(1).max(120) }).strict(),
  playlistDelete: id,
  playlistMembers: z
    .object({
      id,
      ids: z
        .array(id)
        .min(1)
        .max(1000)
        .refine(ids => new Set(ids).size === ids.length),
      action: z.enum(['add', 'remove']),
    })
    .strict(),
  playlistExport: z.union([
    id,
    z
      .object({
        view: z.enum(['practice', 'tag']),
        value: z.string().max(300).optional(),
      })
      .strict(),
  ]),
  libraryReviewOverview: z.undefined(),
  trackTrashPreview: changesSchema,
  trackTrashPreviewJunk: z.undefined(),
  trackTrashStart: id,
  trackTrashHistory: z.undefined(),
  trackTrashRestore: id,
  trashRestoreFiles: changesSchema,

  automationState: z.undefined(),
  automationConfigure: z
    .object({
      enabled: z.boolean(),
      sourceIds: z.array(id).max(20),
      autoApprove: z.boolean(),
      syncEnabled: z.boolean(),
      watchRekordbox: z.boolean(),
    })
    .strict()
    .refine(v => new Set(v.sourceIds).size === v.sourceIds.length),
  automationFolder: z.undefined(),
  automationCheck: z.undefined(),
  automationReveal: z.undefined(),

  duplicateMembers: z
    .object({
      key: z.string().regex(/^(exact|candidate):[a-f0-9]{64}$/),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      offset: z.number().int().min(0).max(100000),
    })
    .strict(),
  duplicateAutoChoose: z.object({ replaceExisting: z.boolean() }).strict().optional(),
  cleanupPreview: z.object({ includeReferenced: z.boolean() }).strict().optional(),
  cleanupStart: id,
  cleanupState: z.undefined(),
  cleanupHistory: z.undefined(),
  cleanupPause: z.undefined(),
  cleanupRestore: id,
  duplicateState: z.undefined(),
  duplicateRun: z.undefined(),
  duplicatePause: z.undefined(),
  duplicateList: z.number().int().min(0).max(100000),
  duplicateResolve: z
    .object({
      key: z.string().regex(/^(exact|candidate):[a-f0-9]{64}$/),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      keeper: id.nullable(),
    })
    .strict(),
  preparationPreview: z
    .object({ scope: z.enum(['all', 'selected']), ids: z.array(id).max(1000) })
    .strict()
    .refine(v =>
      v.scope === 'all'
        ? v.ids.length === 0
        : v.ids.length > 0 && new Set(v.ids).size === v.ids.length
    ),
  preparationPage: z
    .object({
      token: id,
      offset: z.number().int().min(0).max(100000),
      filter: z.enum(['all', 'eligible', 'blocked']),
      reason: z.string().min(1).max(200).optional(),
    })
    .strict(),
  preparationClassify: z
    .object({
      token: id,
      ids: z
        .array(id)
        .min(1)
        .max(1000)
        .refine(ids => new Set(ids).size === ids.length),
      category: z.enum(MUSIC_CATEGORIES).nullable(),
    })
    .strict(),
  preparationApprove: id,
  preparationCancel: z.undefined(),
  preparationExport: id,
  preparationHistory: z.undefined(),
  preparationImported: id,
  preparationVerify: id,
  preparationReveal: id,
  summary: z.undefined(),
  sources: z.undefined(),
  list: querySchema,
  discover: z.undefined(),
  addSource: z.undefined(),
  demo: z.undefined(),
  scan: z.enum(['smart', 'discovery']),
  cancelScan: z.undefined(),
  sourceEnabled: z.object({ id, enabled: z.boolean() }).strict(),
  xmlChoose: z.enum(['file', 'folder', 'refresh']),
  xmlDrop: z
    .array(
      z
        .string()
        .min(1)
        .max(4096)
        .refine(p => p.startsWith('/') && !p.includes('\0'))
    )
    .min(1)
    .max(20),
  xmlImport: id,
  xmlCancel: z.undefined(),
  xmlSummary: z.undefined(),
  xmlList: z
    .object({
      status: z.enum([
        'all',
        'referenced',
        'possible',
        'ambiguous',
        'unmatched',
        'nonlocal',
        'invalid',
        'conflict',
      ]),
      nodeId: z.string().max(100).optional(),
      offset: z.number().int().min(0).max(250000),
      limit: z.number().int().min(1).max(100),
    })
    .strict(),
  xmlTrack: id,
  researchImportChoose: z.undefined(),
  researchImportApply: id,
  researchState: z.undefined(),
  researchPreview: z
    .object({
      provider: z.literal('musicbrainz'),
      scope: z.enum(['selected', 'review', 'pending']),
      ids: z.array(id).max(50),
      limit: z.number().int().min(1).max(50),
    })
    .strict(),
  researchStart: id,
  researchPause: z.undefined(),
  researchTrack: id,
  researchAccept: z
    .object({
      id,
      revision: z.number().int().min(0),
      resultId: id,
      candidate: z.number().int().min(0).max(4),
    })
    .strict(),
  researchClear: z.object({ id, revision: z.number().int().min(0) }).strict(),
  researchSource: z.object({ id, resultId: id, url: z.string().max(2048) }).strict(),
  classificationState: z.undefined(),
  classificationRun: z.undefined(),
  classificationAutomatic: z.boolean(),
  classificationTrack: id,
  classificationRules: z.undefined(),
  classificationRulePreview: z
    .object({
      field: z.enum(['genre', 'versionLabel']),
      match: z.string().trim().min(3).max(120),
      category: z.enum(MUSIC_CATEGORIES),
    })
    .strict(),
  classificationRuleCancel: z.undefined(),
  classificationRuleSave: id,
  classificationRuleRemove: id,
  eraYear: z
    .object({
      id,
      revision: z.number().int().min(0),
      year: z.number().int().min(1900).max(2100).nullable(),
      kind: z.enum(['recording', 'version']),
      note: z.string().trim().max(300),
    })
    .strict(),
  classify: z.object({ changes: changesSchema, category: z.enum(CATEGORIES).nullable() }).strict(),
  review: z.object({ changes: changesSchema, action: z.enum(['review', 'exclude']) }).strict(),
  reveal: id,
  playback: z
    .object({
      action: z.enum(['load', 'play', 'pause', 'seek', 'volume', 'status']),
      id: id.optional(),
      value: z.number().finite().min(0).max(86400).optional(),
    })
    .strict(),
}

export type XMLMatchStatus =
  'referenced' | 'possible' | 'ambiguous' | 'unmatched' | 'nonlocal' | 'invalid'
export interface XMLProgress {
  phase: 'finding' | 'reading' | 'matching' | 'completed' | 'cancelled' | 'failed'
  filename: string
  tracks: number
  bytes: number
  message: string
}
export interface XMLCandidate {
  id: string
  path: string
  filename: string
  modifiedAt: string
  size: number
  valid: boolean
  error: string | null
  tracks: number
  playlists: number
  product: string
}
export interface XMLCandidates {
  candidates: XMLCandidate[]
  warnings: string[]
}
export interface XMLNode {
  id: string
  parentId: string | null
  name: string
  type: 'folder' | 'playlist'
  entries: number
  depth: number
}
export interface XMLSummary {
  id: string
  sourcePath: string
  importedAt: string
  modifiedAt: string
  hash: string
  size: number
  product: string
  tracks: number
  playlists: number
  memberships: number
  dangling: number
  warnings: string[]
  counts: Record<XMLMatchStatus | 'conflict', number>
  nodes: XMLNode[]
  nodeCount: number
  matchedAt: string
}
export interface XMLEntry {
  trackKey: string
  attrs: Record<string, string>
  localPath: string | null
  status: XMLMatchStatus
  reason: string
  fileId: string | null
  candidates: string[]
  conflicts: string[]
  tempo: Record<string, string>[]
  cues: Record<string, string>[]
  tempoCount: number
  cueCount: number
  playlists: string[]
}
export interface XMLQuery {
  status: 'all' | XMLMatchStatus | 'conflict'
  nodeId?: string
  offset: number
  limit: number
}
export interface XMLPage {
  entries: XMLEntry[]
  total: number
}
export interface XMLTrackEvidence {
  snapshot: Pick<XMLSummary, 'id' | 'sourcePath' | 'importedAt' | 'modifiedAt'> | null
  entries: XMLEntry[]
  preview: 'untested' | 'played' | 'failed'
  previewAt: string | null
  previewError: string | null
}

export type ClassificationStatus =
  | 'Ready for Approval'
  | 'Missing Year'
  | 'Verify Release Year'
  | 'Conflicting Evidence'
  | 'Needs Manual Classification'
  | 'Needs Review'
  | 'File Unavailable'
export interface ClassificationProposal {
  category: Category | null
  genre: string | null
  status: ClassificationStatus
  basis:
    | 'clear metadata'
    | 'approved research'
    | 'playlist membership'
    | 'best fit'
    | 'explicit rule'
    | 'version label'
    | 'needs review'
  reasons: string[]
  evidence: { source: string; value: string; meaning: string }[]
  candidates: Category[]
  eraYear: number | null
}
export interface ClassificationEvidence extends ClassificationProposal {
  fileId: string
  computedAt: string
  manualConflict: boolean
  stale: boolean
  era: {
    year: number
    kind: 'recording' | 'version'
    note: string
    confirmedAt: string
    current: boolean
  } | null
}
export interface ClassificationJob {
  status: 'running' | 'completed' | 'paused' | 'interrupted' | 'failed'
  processed: number
  changed: number
  cached: number
  startedAt: string
  finishedAt: string | null
  error: string | null
}
export interface ClassificationState {
  automatic: boolean
  pending: number
  suggestions: number
  ready: number
  unresolved: number
  conflicts: number
  lastJob: ClassificationJob | null
}
export interface RuleDraft {
  field: 'genre' | 'versionLabel'
  match: string
  category: Category
}
export interface ClassificationRule extends RuleDraft {
  id: string
  createdAt: string
}
export interface RulePreview {
  token: string
  rule: RuleDraft
  affected: number
  protected: number
  conflicts: number
  examples: {
    id: string
    title: string
    artist: string
    current: Category | null
    proposed: Category | null
    status: ClassificationStatus
    manual: boolean
  }[]
}

export interface ResearchImportPreview {
  token: string
  label: string
  total: number
  eligible: number
  held: Record<string, number>
  examples: {
    title: string
    artist: string
    genre: string | null
    year: number | null
    reasons: string[]
    sources: { url: string; title: string }[]
  }[]
}
export type ResearchProvider = 'musicbrainz'
export interface ResearchInput {
  title: string
  artist: string
  version: string
  duration: number | null
  taggedYear: number | null
  taggedGenre: string | null
}
export interface ResearchRequest {
  provider: ResearchProvider
  scope: 'selected' | 'review' | 'pending'
  ids: string[]
  limit: number
}
export interface ResearchPreview {
  token: string
  provider: ResearchProvider
  tracks: { id: string; input: ResearchInput; cached: boolean }[]
  skipped: number
  networkTracks: number
  maxRequests: number
  expiresAt: string
}
export interface ResearchCandidate {
  title: string
  artist: string
  version: string
  sameVersion: boolean
  genre: string | null
  year: number | null
  date: string | null
  yearKind: 'recording' | 'version' | 'release' | 'unknown'
  genreSources: string[]
  yearSources: string[]
  sources: { url: string; title: string }[]
  reasons: string[]
  category: Category | null
}
export interface ResearchResult {
  id: string
  provider: ResearchProvider
  model: string | null
  retrievedAt: string
  candidates: ResearchCandidate[]
  notes: string[]
}
export interface ResearchJob {
  status: 'running' | 'paused' | 'interrupted' | 'completed' | 'failed'
  provider: ResearchProvider
  total: number
  completed: number
  cached: number
  failed: number
  skipped: number
  message: string
  startedAt: string
  failure?: ResearchFailure
  failedTrack?: { id: string; title: string; artist: string }
}
export interface ResearchFailure {
  kind: 'http' | 'network' | 'timeout' | 'unknown'
  status?: number
}
export interface ResearchState {
  pending: number
  results: number
  approved: number
  job: ResearchJob | null
}
export interface ResearchEvidence {
  conflict: boolean
  result: ResearchResult | null
  stale: boolean
  approved: {
    candidate: ResearchCandidate
    resultId: string
    current: boolean
    approvedAt: string
  } | null
}

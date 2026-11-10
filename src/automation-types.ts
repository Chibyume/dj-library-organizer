export interface AutomationOptions {
  enabled: boolean
  sourceIds: string[]
  autoApprove: boolean
  syncEnabled: boolean
  watchRekordbox: boolean
}
export interface AutomationConfig extends AutomationOptions {
  syncDirectory: string | null
  rekordboxPath: string | null
}
export interface AutomationState {
  config: AutomationConfig
  active: boolean
  running: boolean
  phase: string
  pending: number
  lastCheckedAt: string | null
  lastCompletedAt: string | null
  error: string | null
  sync: {
    updatedAt: string
    tracks: number
    held: number
    awaitingApproval: number
    practiceTracks: number
    practicePlaylists: number
    practiceOmitted: number
    preparedIssue: string | null
    xmlPath: string
    hash: string
  } | null
}

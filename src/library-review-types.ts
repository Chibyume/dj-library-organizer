/** Review uses the same assessment as the Rekordbox preparation preview. */
export interface LibraryReviewOverview {
  /** Held tracks plus eligible tracks still awaiting playlist approval. */
  total: number
  needsApproval: number
  held: number
  reasons: Record<string, number>
}

/** Other nonempty values are exact preparation reason strings. */
export type LibraryReviewFilter = 'all' | 'held' | 'approval' | string

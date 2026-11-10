import type { LibraryDB } from './db'
import type { LibraryPage, LibraryQuery } from './shared'
import type { PreparationItem } from './preparation-types'
import type { LibraryReviewOverview } from './library-review-types'

/** Project a preparation assessment into Library Review without creating a preview. */
export class LibraryReview {
  constructor(
    private db: LibraryDB,
    private items: PreparationItem[]
  ) {}

  overview(): LibraryReviewOverview {
    const reasons: Record<string, number> = {}
    let held = 0
    let needsApproval = 0
    for (const item of this.items) {
      if (item.reason) {
        held++
        reasons[item.reason] = (reasons[item.reason] || 0) + 1
      } else if (!item.approved) needsApproval++
    }
    return { total: held + needsApproval, held, needsApproval, reasons }
  }

  list(query: LibraryQuery): LibraryPage {
    const filter = query.value || 'all'
    const selected = this.items.filter(item => {
      if (filter === 'held') return !!item.reason
      if (filter === 'approval') return !item.reason && !item.approved
      if (filter === 'all') return !!item.reason || !item.approved
      return item.reason === filter
    })
    if (!selected.length) return { total: 0, tracks: [] }
    const byId = new Map(selected.map(item => [item.id, item]))
    // A JSON table avoids SQLite's parameter limit for large review batches.
    const values: unknown[] = [
      JSON.stringify(
        Object.fromEntries(selected.map(item => [item.id, item.reason || 'Ready to approve']))
      ),
    ]
    const from = ' FROM files f JOIN json_each(?) assessment ON assessment.key=f.id'
    const clauses = ["f.availability NOT IN ('trashed','removed')"]
    if (query.search) {
      clauses.push(
        "(COALESCE(f.artist,'') LIKE ? ESCAPE '\\' OR COALESCE(f.title,'') LIKE ? ESCAPE '\\' OR f.filename LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM organization_tags ot WHERE ot.fileId=f.id AND ot.value LIKE ? ESCAPE '\\'))"
      )
      const search = '%' + query.search.replace(/[\\%_]/g, '\\$&') + '%'
      values.push(search, search, search, search)
    }
    const columns: Record<string, string> = {
      artist: 'artist',
      title: 'title',
      bpm: 'bpm',
      year: 'year',
      genre: 'genre',
      category: 'category',
      review: 'review',
      duration: 'duration',
      filename: 'filename',
      availability: 'availability',
      addedAt: 'addedAt',
    }
    const column = columns[query.sort] || 'artist'
    const sort = query.sort === 'review' ? 'assessment.value' : `f.${column}`
    const direction = query.direction === 'desc' ? 'DESC' : 'ASC'
    const where = ' WHERE ' + clauses.join(' AND ')
    const total = (
      this.db.db.prepare('SELECT COUNT(*) n' + from + where).get(...values) as {
        n: number
      }
    ).n
    const rows = this.db.db
      .prepare(
        `SELECT f.id${from}${where} ORDER BY (${sort} IS NULL OR ${sort}='') ASC,${sort} COLLATE NOCASE ${direction},f.id LIMIT ? OFFSET ?`
      )
      .all(...values, query.limit, query.offset) as { id: string }[]
    return {
      total,
      tracks: rows.map(({ id }) => {
        const item = byId.get(id)!
        return {
          ...this.db.get(id)!,
          preparationReason: item.reason,
          preparationApproved: item.approved,
        }
      }),
    }
  }
}

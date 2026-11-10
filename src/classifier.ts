import { researchInput, inputDigest } from './research-identity'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { LibraryDB } from './db'
import {
  CLASSIFIER_REVISION,
  matchesRule,
  normalize,
  propose,
  type ClassificationInput,
} from './classification'
import type {
  ClassificationEvidence,
  ClassificationJob,
  ClassificationProposal,
  ClassificationRule,
  ClassificationState,
  RuleDraft,
  RulePreview,
  Track,
} from './shared'

type EraRow = {
  year: number
  kind: 'recording' | 'version'
  note: string
  signature: string
  confirmedAt: string
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class Classifier {
  private task: Promise<void> | null = null
  private stopped = false
  private closing = false
  private previews = new Map<string, { preview: RulePreview; epoch: number; expires: number }>()
  private previewing = false
  private previewCancelled = false
  constructor(
    private library: LibraryDB,
    private notify: (progress: ClassificationJob) => void
  ) {
    const job = this.state().lastJob
    if (job?.status === 'running')
      this.saveJob({
        ...job,
        status: 'interrupted',
        finishedAt: new Date().toISOString(),
      })
  }
  get running() {
    return this.task !== null
  }
  rules(): ClassificationRule[] {
    return this.library.db
      .prepare('SELECT * FROM classification_rules ORDER BY createdAt,id LIMIT 200')
      .all() as ClassificationRule[]
  }
  private input(track: Track): {
    value: ClassificationInput
    era: EraRow | null
  } {
    const signature = (track as Track & { signature: string }).signature
    const era = this.library.db.prepare('SELECT * FROM era_years WHERE fileId=?').get(track.id) as
      EraRow | undefined
    const references = this.library.db
      .prepare(
        "SELECT t.attrs,m.conflicts FROM rb_matches m JOIN rb_snapshots s ON s.id=m.snapshotId AND s.active=1 JOIN rb_tracks t ON t.snapshotId=m.snapshotId AND t.trackKey=m.trackKey WHERE m.fileId=? AND m.status='referenced' ORDER BY m.trackKey LIMIT 21"
      )
      .all(track.id) as { attrs: string; conflicts: string }[]
    const approved = this.library.db
      .prepare('SELECT * FROM research_approved WHERE fileId=?')
      .get(track.id) as
      | {
          signature: string
          inputHash: string
          value: string
          approvedAt: string
        }
      | undefined
    const research = approved
      ? (JSON.parse(approved.value) as {
          candidate: { genre: string | null }
          provider: string
          sources: { url: string }[]
        })
      : null
    const identity = researchInput(track)
    const playlists = this.library.db
      .prepare(
        "SELECT DISTINCT n.name FROM rb_matches m JOIN rb_snapshots s ON s.id=m.snapshotId AND s.active=1 JOIN rb_memberships b ON b.snapshotId=m.snapshotId AND b.trackKey=m.trackKey JOIN rb_nodes n ON n.snapshotId=b.snapshotId AND n.id=b.nodeId WHERE m.fileId=? AND m.status='referenced' AND n.type='playlist' ORDER BY n.name LIMIT 21"
      )
      .all(track.id) as { name: string }[]
    const value: ClassificationInput = {
      research:
        approved && research
          ? {
              genre: research.candidate.genre,
              source: `Approved ${research.provider} research (${approved.approvedAt}); ${research.sources.map(s => s.url).join(' ')}`,
              current:
                approved.signature === signature &&
                Boolean(identity && inputDigest(identity) === approved.inputHash),
            }
          : undefined,
      signature,
      filename: track.filename.slice(0, 1024),
      title: track.title?.slice(0, 1024) || null,
      genre: track.genre?.slice(0, 10000) || null,
      genres: Array.isArray(track.tags.genre)
        ? track.tags.genre
            .filter((g): g is string => typeof g === 'string')
            .slice(0, 30)
            .map(g => g.slice(0, 1000))
        : [],
      year: track.year,
      originalYear: typeof track.tags.originalyear === 'number' ? track.tags.originalyear : null,
      originalDate:
        typeof track.tags.originaldate === 'string' ? track.tags.originaldate.slice(0, 100) : null,
      availability: track.availability,
      partial: Boolean(track.metadataError || track.tags.partialRead),
      xml: references.slice(0, 20).map(r => {
        const attrs = JSON.parse(r.attrs) as Record<string, string>
        const conflicts = JSON.parse(r.conflicts) as string[]
        return {
          genre: (attrs.Genre || '').slice(0, 1000),
          year: (attrs.Year || '').slice(0, 100),
          title: (attrs.Name || '').slice(0, 1024),
          identityConflict: conflicts.some(c => /^(Name|Artist|Size|TotalTime):/.test(c)),
        }
      }),
      xmlOverflow: references.length > 20,
      playlists: playlists.length > 20 ? [] : playlists.map(p => p.name.slice(0, 1000)),
      era: era
        ? {
            year: era.year,
            kind: era.kind,
            current: era.signature === signature,
            note: era.note,
            confirmedAt: era.confirmedAt,
          }
        : null,
    }
    return { value, era: era || null }
  }
  private hash(input: ClassificationInput, rules: ClassificationRule[]) {
    return digest({ engine: CLASSIFIER_REVISION, input, rules })
  }
  private compatibleHash(
    input: ClassificationInput,
    rules: ClassificationRule[],
    proposal: ClassificationProposal,
    saved?: { inputHash: string; result: string }
  ) {
    const current = this.hash(input, rules)
    // Revision 4 separates named genres that revision 3 grouped together. An
    // unchanged proposal for exactly the same input/rules retains the user's
    // existing acknowledgment and export approval; changed evidence never does.
    if (CLASSIFIER_REVISION === 4 && saved?.inputHash === digest({ engine: 3, input, rules })) {
      const {
        fileId: _fileId,
        computedAt: _computedAt,
        manualConflict: _manualConflict,
        stale: _stale,
        era: _era,
        ...previous
      } = JSON.parse(saved.result) as ClassificationEvidence
      if (isDeepStrictEqual(previous, proposal)) return saved.inputHash
    }
    return current
  }
  state(): ClassificationState {
    const settings = this.library.db
      .prepare('SELECT automatic FROM classification_settings WHERE id=1')
      .get() as { automatic: number }
    const pending = (
      this.library.db.prepare('SELECT COUNT(*) n FROM classification_queue').get() as { n: number }
    ).n
    const counts = this.library.db
      .prepare(
        "SELECT COALESCE(SUM(json_extract(result,'$.category') IS NOT NULL AND f.manual=0 AND f.review!='Excluded'),0) suggestions,COALESCE(SUM(json_extract(result,'$.status')='Ready for Approval' AND f.manual=0 AND f.review='Ready for Approval'),0) ready,COALESCE(SUM(json_extract(result,'$.status')!='Ready for Approval' AND f.manual=0 AND f.review!='Excluded'),0) unresolved,COALESCE(SUM(json_extract(result,'$.manualConflict')=1 AND acknowledgedHash IS NOT inputHash AND f.review!='Excluded'),0) conflicts FROM classification_results r JOIN files f ON f.id=r.fileId WHERE f.availability NOT IN ('trashed','removed')"
      )
      .get() as Omit<ClassificationState, 'automatic' | 'pending' | 'lastJob'>
    const job = this.library.db.prepare('SELECT data FROM classification_job WHERE id=1').get() as
      { data: string } | undefined
    return {
      ...counts,
      automatic: Boolean(settings.automatic),
      pending,
      lastJob: job ? JSON.parse(job.data) : null,
    }
  }
  private saveJob(job: ClassificationJob) {
    this.library.db
      .prepare(
        'INSERT INTO classification_job VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'
      )
      .run(JSON.stringify(job))
  }
  enqueueAll() {
    if (this.closing) return
    const count = (
      this.library.db.prepare('SELECT COUNT(*) n FROM files').get() as {
        n: number
      }
    ).n
    if (count > 1000000)
      throw new Error(
        'Classification is limited to one million catalog files. Reduce the catalog scope.'
      )
    this.library.db
      .prepare(
        "INSERT OR IGNORE INTO classification_queue SELECT id FROM files WHERE availability NOT IN ('trashed','removed')"
      )
      .run()
  }
  schedule() {
    if (this.closing) return
    this.enqueueAll()
    if (this.state().automatic) this.start()
  }
  automatic(enabled: boolean) {
    this.library.db
      .prepare('UPDATE classification_settings SET automatic=? WHERE id=1')
      .run(Number(enabled))
    if (enabled) {
      this.stopped = false
      this.schedule()
    } else this.stopped = true
  }
  start() {
    if (this.closing || this.running) return
    this.stopped = false
    // Defer the first batch so the caller receives its IPC reply promptly.
    this.task = Promise.resolve()
      .then(() => this.run())
      .finally(() => {
        this.task = null
      })
  }
  runNow() {
    this.stopped = false
    this.enqueueAll()
    this.start()
  }
  async wait() {
    await this.task
  }
  async close() {
    this.closing = true
    this.stopped = true
    await this.wait()
    while (this.previewing) await new Promise<void>(resolve => setImmediate(resolve))
    this.previews.clear()
  }
  private async run() {
    const job: ClassificationJob = {
      status: 'running',
      processed: 0,
      changed: 0,
      cached: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    }
    this.saveJob(job)
    this.notify({ ...job })
    let lastEmit = Date.now()
    try {
      while (!this.stopped) {
        const ids = this.library.db
          .prepare('SELECT fileId FROM classification_queue ORDER BY rowid LIMIT 100')
          .all() as { fileId: string }[]
        if (!ids.length) break
        const rules = this.rules()
        const counters = {
          processed: job.processed,
          changed: job.changed,
          cached: job.cached,
        }
        try {
          this.library.db.transaction(() => {
            for (const { fileId } of ids) {
              const track = this.library.get(fileId)
              if (track && !['trashed', 'removed'].includes(track.availability)) {
                const { value: input, era } = this.input(track)
                const old = this.library.db
                  .prepare(
                    'SELECT inputHash,acknowledgedHash,result FROM classification_results WHERE fileId=?'
                  )
                  .get(fileId) as
                  | {
                      inputHash: string
                      acknowledgedHash: string | null
                      result: string
                    }
                  | undefined
                const proposal = propose(input, rules)
                const inputHash = this.compatibleHash(input, rules, proposal, old)
                const manualConflict =
                  track.manual &&
                  track.review !== 'Excluded' &&
                  old?.acknowledgedHash !== inputHash &&
                  (proposal.status === 'Conflicting Evidence' ||
                    (proposal.category !== null && track.category !== proposal.category))
                const evidence: ClassificationEvidence = {
                  ...proposal,
                  fileId,
                  computedAt: new Date().toISOString(),
                  manualConflict,
                  stale: false,
                  era: era
                    ? {
                        year: era.year,
                        kind: era.kind,
                        note: era.note,
                        confirmedAt: era.confirmedAt,
                        current: Boolean(input.era?.current),
                      }
                    : null,
                }
                if (old?.inputHash === inputHash) job.cached++
                if (
                  old?.inputHash !== inputHash ||
                  JSON.parse(old.result).manualConflict !== manualConflict
                ) {
                  this.library.db
                    .prepare(
                      'INSERT INTO classification_results(fileId,inputHash,result,computedAt) VALUES(?,?,?,?) ON CONFLICT(fileId) DO UPDATE SET inputHash=excluded.inputHash,result=excluded.result,computedAt=excluded.computedAt'
                    )
                    .run(fileId, inputHash, JSON.stringify(evidence), evidence.computedAt)
                  if (old?.inputHash !== inputHash) job.changed++
                }
                if (!track.manual) {
                  if (track.category !== proposal.category || track.review !== proposal.status)
                    this.library.db
                      .prepare(
                        'UPDATE files SET category=?,review=?,revision=revision+1 WHERE id=? AND manual=0 AND revision=?'
                      )
                      .run(proposal.category, proposal.status, fileId, track.revision)
                } else if (
                  manualConflict &&
                  !['Excluded', 'File Changed', 'Needs Review', 'Conflicting Evidence'].includes(
                    track.review
                  )
                ) {
                  this.library.db
                    .prepare(
                      "UPDATE files SET review='Conflicting Evidence',revision=revision+1 WHERE id=? AND revision=?"
                    )
                    .run(fileId, track.revision)
                }
              }
              this.library.db.prepare('DELETE FROM classification_queue WHERE fileId=?').run(fileId)
              job.processed++
            }
            this.saveJob(job)
          })()
        } catch (error) {
          Object.assign(job, counters)
          throw error
        }
        if (Date.now() - lastEmit > 500) {
          this.notify({ ...job })
          lastEmit = Date.now()
        }
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      job.status = this.stopped ? 'paused' : 'completed'
    } catch (error) {
      job.status = 'failed'
      job.error =
        error instanceof Error ? error.message : 'Classification failed. Pending work was retained.'
    } finally {
      job.finishedAt = new Date().toISOString()
      this.saveJob(job)
      this.notify({ ...job })
    }
  }
  track(id: string): ClassificationEvidence | null {
    const track = this.library.get(id)
    if (!track) throw new Error('Track not found.')
    const saved = this.library.db
      .prepare(
        'SELECT inputHash,result,acknowledgedHash FROM classification_results WHERE fileId=?'
      )
      .get(id) as { inputHash: string; result: string; acknowledgedHash: string | null } | undefined
    if (!saved) return null
    const evidence = JSON.parse(saved.result) as ClassificationEvidence
    const { value: input } = this.input(track)
    const rules = this.rules()
    return {
      ...evidence,
      manualConflict:
        track.manual &&
        track.review !== 'Excluded' &&
        saved.acknowledgedHash !== saved.inputHash &&
        (evidence.status === 'Conflicting Evidence' ||
          (evidence.category !== null && evidence.category !== track.category)),
      stale: this.compatibleHash(input, rules, propose(input, rules), saved) !== saved.inputHash,
    }
  }
  eraYear(args: {
    id: string
    revision: number
    year: number | null
    kind: 'recording' | 'version'
    note: string
  }) {
    this.library.db.transaction(() => {
      const track = this.library.get(args.id) as (Track & { signature: string }) | undefined
      if (
        !track ||
        ['trashed', 'removed'].includes(track.availability) ||
        track.revision !== args.revision
      )
        throw new Error('The track changed. Refresh before confirming its year.')
      const old = this.library.db.prepare('SELECT * FROM era_years WHERE fileId=?').get(track.id)
      if (args.year === null)
        this.library.db.prepare('DELETE FROM era_years WHERE fileId=?').run(track.id)
      else
        this.library.db
          .prepare(
            'INSERT INTO era_years VALUES(?,?,?,?,?,?) ON CONFLICT(fileId) DO UPDATE SET year=excluded.year,kind=excluded.kind,note=excluded.note,signature=excluded.signature,confirmedAt=excluded.confirmedAt'
          )
          .run(track.id, args.year, args.kind, args.note, track.signature, new Date().toISOString())
      this.library.db
        .prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?)')
        .run(
          randomUUID(),
          track.id,
          'eraYear',
          JSON.stringify(old || null),
          JSON.stringify(
            args.year === null ? null : { year: args.year, kind: args.kind, note: args.note }
          ),
          new Date().toISOString(),
          track.revision + 1
        )
      this.library.db.prepare('UPDATE files SET revision=revision+1 WHERE id=?').run(track.id)
      this.library.db.prepare('INSERT OR IGNORE INTO classification_queue VALUES(?)').run(track.id)
      this.library.db.prepare('UPDATE classification_settings SET epoch=epoch+1 WHERE id=1').run()
    })()
    if (this.state().automatic) this.start()
  }
  private epoch() {
    return (
      this.library.db.prepare('SELECT epoch FROM classification_settings WHERE id=1').get() as {
        epoch: number
      }
    ).epoch
  }
  cancelPreview() {
    this.previewCancelled = true
  }
  async preview(rule: RuleDraft): Promise<RulePreview> {
    if (this.previewing) throw new Error('A rule preview is already running.')
    if (!normalize(rule.match)) throw new Error('Use a phrase with letters or numbers.')
    if (this.rules().length >= 200)
      throw new Error('The saved-rule limit is 200. Remove a rule first.')
    this.previewing = true
    this.previewCancelled = false
    const deadline = Date.now() + 120000
    const epoch = this.epoch(),
      rules = this.rules(),
      token = randomUUID()
    const preview: RulePreview = {
      token,
      rule,
      affected: 0,
      protected: 0,
      conflicts: 0,
      examples: [],
    }
    try {
      let cursor = 0,
        visited = 0
      while (!this.closing) {
        if (this.previewCancelled) throw new Error('Rule preview cancelled. No rule was saved.')
        if (Date.now() > deadline)
          throw new Error('Rule preview exceeded its two-minute limit. No rule was saved.')
        const batch = this.library.db
          .prepare(
            "SELECT rowid cursor,id FROM files WHERE availability NOT IN ('trashed','removed') AND rowid>? ORDER BY rowid LIMIT 200"
          )
          .all(cursor) as { cursor: number; id: string }[]
        if (!batch.length) break
        for (const row of batch) {
          cursor = row.cursor
          if (++visited > 1000000)
            throw new Error('Rule previews are limited to one million catalog files.')
          const track = this.library.get(row.id)!,
            { value: input } = this.input(track)
          if (!matchesRule(input, rule)) continue
          const proposed = propose(input, [...rules, { ...rule, id: token, createdAt: 'preview' }])
          preview.affected++
          if (track.manual) preview.protected++
          if (
            proposed.status === 'Conflicting Evidence' ||
            (track.manual && proposed.category !== null && proposed.category !== track.category)
          )
            preview.conflicts++
          if (preview.examples.length < 20)
            preview.examples.push({
              id: track.id,
              title: track.title || track.filename,
              artist: track.artist || '',
              current: track.category,
              proposed: proposed.category,
              status: proposed.status,
              manual: track.manual,
            })
        }
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      if (this.closing || epoch !== this.epoch())
        throw new Error('The library changed during preview. Preview again before saving the rule.')
      for (const [key, value] of this.previews)
        if (value.expires < Date.now()) this.previews.delete(key)
      if (this.previews.size >= 10) this.previews.delete(this.previews.keys().next().value!)
      this.previews.set(token, {
        preview,
        epoch,
        expires: Date.now() + 300000,
      })
      return preview
    } finally {
      this.previewing = false
    }
  }
  saveRule(token: string) {
    const saved = this.previews.get(token)
    if (!saved || saved.expires < Date.now() || saved.epoch !== this.epoch())
      throw new Error('This preview is stale. Preview the rule again before saving.')
    const rule = saved.preview.rule
    if (
      this.rules().some(
        r =>
          r.field === rule.field &&
          normalize(r.match) === normalize(rule.match) &&
          r.category === rule.category
      )
    )
      throw new Error('That rule is already saved.')
    this.library.db.transaction(() => {
      this.library.db
        .prepare('INSERT INTO classification_rules VALUES(?,?,?,?,?)')
        .run(randomUUID(), rule.field, rule.match, rule.category, new Date().toISOString())
      this.library.db.prepare('UPDATE classification_settings SET epoch=epoch+1 WHERE id=1').run()
    })()
    this.previews.clear()
    this.schedule()
  }
  removeRule(id: string) {
    const removed = this.library.db
      .prepare('DELETE FROM classification_rules WHERE id=?')
      .run(id).changes
    if (!removed) throw new Error('Rule not found.')
    this.library.db.prepare('UPDATE classification_settings SET epoch=epoch+1 WHERE id=1').run()
    this.previews.clear()
    this.schedule()
  }
}

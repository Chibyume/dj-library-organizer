import { normalize } from './classification'
import { createHash, randomUUID } from 'node:crypto'
import { LibraryDB } from './db'
import { Classifier } from './classifier'
import {
  adapters,
  hasVersion,
  RESEARCH_REVISION,
  publicSource,
  categoryFor,
  type ResearchAdapter,
} from './research-provider'
import type {
  ResearchInput,
  ResearchResult,
  ResearchRequest,
  ResearchPreview,
  ResearchProvider,
  ResearchJob,
  ResearchState,
  ResearchEvidence,
  ResearchCandidate,
  Track,
} from './shared'
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const signature = (t: Track) => (t as Track & { signature: string }).signature
export { researchInput } from './research-identity'
import { researchInput } from './research-identity'
import { researchFailure, failureMessage } from './research-failure'
export function researchHash(input: ResearchInput, provider: ResearchProvider) {
  return digest({
    revision: RESEARCH_REVISION,
    provider,
    model: null,
    input,
  })
}
type Queue = {
  fileId: string
  provider: ResearchProvider
  inputHash: string
  signature: string
  input: string
  state: string
}
type Approved = {
  signature: string
  inputHash: string
  value: string
  approvedAt: string
}
export class Researcher {
  private previews = new Map<
    string,
    { preview: ResearchPreview; items: Queue[]; expires: number }
  >()
  private task: Promise<void> | null = null
  private abort: AbortController | null = null
  constructor(
    private library: LibraryDB,
    private classifier: Classifier,
    private notify: () => void,
    private providers = adapters()
  ) {
    // Retire unapproved AI data, but preserve every explicit user approval.
    this.library.db.transaction(() => {
      this.library.db.prepare("DELETE FROM research_queue WHERE provider!='musicbrainz'").run()
      this.library.db.prepare("DELETE FROM research_results WHERE provider!='musicbrainz'").run()
      this.library.db
        .prepare("DELETE FROM research_job WHERE json_extract(data,'$.provider')!='musicbrainz'")
        .run()
    })()
    const job = this.state().job
    if (job?.status === 'running')
      this.saveJob({
        ...job,
        status: 'interrupted',
        message:
          'Interrupted lookup may have reached the provider. It will not be resubmitted automatically. Preview pending items to resume.',
      })
    this.library.db
      .prepare("UPDATE research_queue SET state='uncertain' WHERE state='sending'")
      .run()
  }
  get running() {
    return this.task !== null
  }
  state(): ResearchState {
    const count = (sql: string) => (this.library.db.prepare(sql).get() as { n: number }).n
    const row = this.library.db.prepare('SELECT data FROM research_job WHERE id=1').get() as
      { data: string } | undefined
    return {
      pending: count("SELECT COUNT(*) n FROM research_queue WHERE state='pending'"),
      results: count('SELECT COUNT(DISTINCT fileId) n FROM research_results'),
      approved: count('SELECT COUNT(*) n FROM research_approved'),
      job: row ? JSON.parse(row.data) : null,
    }
  }
  private saveJob(job: ResearchJob) {
    this.library.db
      .prepare(
        'INSERT INTO research_job VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'
      )
      .run(JSON.stringify(job))
    this.notify()
  }
  private allowed(t: Track) {
    return Boolean(
      this.library.db
        .prepare(
          'SELECT 1 FROM locations l JOIN sources s ON s.id=l.sourceId WHERE l.fileId=? AND s.enabled=1 AND l.available=1 LIMIT 1'
        )
        .get(t.id)
    )
  }
  private cache(hash: string, provider: ResearchProvider): ResearchResult | null {
    const row = this.library.db
      .prepare(
        "SELECT result FROM research_results WHERE inputHash=? AND provider=? ORDER BY json_extract(result,'$.retrievedAt') DESC LIMIT 1"
      )
      .get(hash, provider) as { result: string } | undefined
    if (!row) return null
    const result = JSON.parse(row.result) as ResearchResult
    return Date.now() - Date.parse(result.retrievedAt) < 7 * 86400000 ? result : null
  }
  preview(args: ResearchRequest): ResearchPreview {
    if (args.provider !== 'musicbrainz') throw new Error('Only MusicBrainz research is available.')
    if (this.running) throw new Error('Pause the current research batch before previewing another.')
    let tracks: Track[] = []
    if (args.scope === 'pending') {
      const pending = this.library.db
        .prepare(
          "SELECT fileId FROM research_queue WHERE state='pending' AND provider=? ORDER BY rowid LIMIT ?"
        )
        .all(args.provider, args.limit) as { fileId: string }[]
      tracks = pending.map(p => this.library.get(p.fileId)).filter((t): t is Track => Boolean(t))
    } else if (args.scope === 'selected')
      tracks = [...new Set(args.ids)]
        .slice(0, args.limit)
        .map(id => this.library.get(id))
        .filter((t): t is Track => Boolean(t))
    else {
      const rows = this.library.db
        .prepare(
          "SELECT id FROM files WHERE availability NOT IN ('trashed','removed') AND manual=0 AND review!='Excluded' AND (category IS NULL OR review!='Ready for Approval') ORDER BY addedAt,id LIMIT 1000"
        )
        .all() as { id: string }[]
      tracks = rows
        .map(r => this.library.get(r.id)!)
        .filter(t => {
          const input = researchInput(t)
          return (
            this.allowed(t) &&
            input &&
            !this.cache(researchHash(input, args.provider), args.provider)
          )
        })
        .slice(0, args.limit)
    }
    const items: Queue[] = []
    let skipped = 0
    const rows: ResearchPreview['tracks'] = []
    for (const track of tracks) {
      const input = researchInput(track)
      if (!input || !this.allowed(track) || track.review === 'Excluded') {
        skipped++
        continue
      }
      const hash = researchHash(input, args.provider)
      const cachedResult = this.cache(hash, args.provider)
      const cached = Boolean(cachedResult)
      items.push({
        fileId: track.id,
        provider: args.provider,
        inputHash: hash,
        signature: signature(track),
        input: JSON.stringify({ query: input, cached: cachedResult }),
        state: 'pending',
      })
      rows.push({ id: track.id, input, cached })
    }
    const networkTracks = rows.filter(r => !r.cached).length
    const token = randomUUID(),
      expires = Date.now() + 5 * 60000
    const preview: ResearchPreview = {
      token,
      provider: args.provider,
      tracks: rows,
      skipped,
      networkTracks,
      maxRequests: networkTracks * 12,
      expiresAt: new Date(expires).toISOString(),
    }
    for (const [key, p] of this.previews) if (p.expires < Date.now()) this.previews.delete(key)
    if (this.previews.size >= 10) this.previews.delete(this.previews.keys().next().value!)
    this.previews.set(token, { preview, items, expires })
    return preview
  }
  start(token: string) {
    if (this.running) throw new Error('Research is already running.')
    const p = this.previews.get(token)
    if (!p || p.expires < Date.now()) throw new Error('Preview expired. Preview the batch again.')
    if (!p.items.length)
      throw new Error(
        'No eligible tracks. Select tracks with an embedded title and artist, or a different batch.'
      )
    for (const row of p.items) {
      const t = this.library.get(row.fileId)
      const input = t && researchInput(t)
      if (
        !t ||
        !input ||
        !this.allowed(t) ||
        signature(t) !== row.signature ||
        researchHash(input, row.provider) !== row.inputHash
      )
        throw new Error('Track metadata or source access changed. Preview again.')
    }
    this.previews.delete(token)
    this.library.db.transaction(() => {
      const insert = this.library.db.prepare(
        'INSERT INTO research_queue(fileId,provider,inputHash,signature,input,state) VALUES(@fileId,@provider,@inputHash,@signature,@input,@state) ON CONFLICT(fileId) DO UPDATE SET provider=excluded.provider,inputHash=excluded.inputHash,signature=excluded.signature,input=excluded.input,state=excluded.state'
      )
      for (const row of p.items) insert.run(row)
    })()
    const job: ResearchJob = {
      status: 'running',
      provider: p.preview.provider,
      total: p.items.length,
      completed: 0,
      cached: 0,
      failed: 0,
      skipped: 0,
      message: 'Researching the previewed batch',
      startedAt: new Date().toISOString(),
    }
    this.saveJob(job)
    this.abort = new AbortController()
    const abort = this.abort
    this.task = Promise.resolve()
      .then(() =>
        this.run(
          job,
          abort.signal,
          p.items.map(row => row.fileId)
        )
      )
      .finally(() => {
        this.task = null
        this.abort = null
      })
  }
  pause() {
    this.abort?.abort()
  }
  async wait() {
    await this.task
  }
  async close() {
    this.pause()
    await this.wait()
    this.previews.clear()
  }
  private async run(job: ResearchJob, signal: AbortSignal, ids: string[]) {
    try {
      while (!signal.aborted) {
        const row = this.library.db
          .prepare(
            `SELECT * FROM research_queue WHERE state='pending' AND fileId IN (${ids.map(() => '?').join(',')}) ORDER BY rowid LIMIT 1`
          )
          .get(...ids) as Queue | undefined
        if (!row) break
        const track = this.library.get(row.fileId),
          input = track && researchInput(track)
        if (
          !track ||
          !input ||
          !this.allowed(track) ||
          track.review === 'Excluded' ||
          signature(track) !== row.signature ||
          researchHash(input, row.provider) !== row.inputHash
        ) {
          this.library.db.prepare('DELETE FROM research_queue WHERE fileId=?').run(row.fileId)
          job.skipped++
          this.saveJob(job)
          continue
        }
        const pinned = JSON.parse(row.input) as {
          cached?: ResearchResult | null
        }
        let result = pinned.cached || this.cache(row.inputHash, row.provider)
        const cached = Boolean(result)
        if (!result) {
          this.library.db
            .prepare("UPDATE research_queue SET state='sending' WHERE fileId=?")
            .run(row.fileId)
          try {
            result = await this.providers[row.provider].lookup(
              input,
              AbortSignal.any([signal, AbortSignal.timeout(120000)])
            )
          } catch (error) {
            this.library.db
              .prepare("UPDATE research_queue SET state='uncertain' WHERE fileId=?")
              .run(row.fileId)
            job.failed++
            if (signal.aborted) {
              job.status = 'paused'
              job.message =
                'Paused. The active request may have reached the provider and will not be resubmitted automatically.'
              this.saveJob(job)
              return
            }
            job.status = 'failed'
            job.failure = researchFailure(error)
            job.failedTrack = {
              id: row.fileId,
              title: input.title,
              artist: input.artist,
            }
            job.message =
              failureMessage(job.failure) +
              ' Preview pending items to continue; select the failed track for a new explicit batch.'
            this.saveJob(job)
            return
          }
        }
        const current = this.library.get(row.fileId)
        const fresh = current && researchInput(current)
        if (
          !current ||
          !fresh ||
          !this.allowed(current) ||
          signature(current) !== row.signature ||
          researchHash(fresh, row.provider) !== row.inputHash
        ) {
          job.skipped++
        } else {
          this.library.db
            .prepare(
              'INSERT INTO research_results VALUES(?,?,?,?,?) ON CONFLICT(fileId,provider) DO UPDATE SET inputHash=excluded.inputHash,signature=excluded.signature,result=excluded.result'
            )
            .run(row.fileId, row.provider, row.inputHash, row.signature, JSON.stringify(result))
          job.completed++
          if (cached) job.cached++
        }
        this.library.db.prepare('DELETE FROM research_queue WHERE fileId=?').run(row.fileId)
        this.saveJob(job)
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      job.status = signal.aborted ? 'paused' : 'completed'
      job.message = signal.aborted
        ? 'Paused between tracks. Preview pending items to resume.'
        : 'Batch complete. Review source-backed suggestions on each track.'
      this.saveJob(job)
    } catch {
      job.status = 'failed'
      job.message =
        'Research could not save its results. Restart the app; in-flight requests will not be retried automatically.'
      this.saveJob(job)
    }
  }
  track(id: string): ResearchEvidence {
    const track = this.library.get(id)
    if (!track) throw new Error('Track not found.')
    const input = researchInput(track)
    const row = this.library.db
      .prepare(
        "SELECT * FROM research_results WHERE fileId=? AND provider='musicbrainz' ORDER BY json_extract(result,'$.retrievedAt') DESC LIMIT 1"
      )
      .get(id) as
      | {
          provider: ResearchProvider
          inputHash: string
          signature: string
          result: string
        }
      | undefined
    const approved = this.library.db
      .prepare('SELECT * FROM research_approved WHERE fileId=?')
      .get(id) as Approved | undefined
    const result: ResearchResult | null = row ? JSON.parse(row.result) : null
    if (result && input)
      for (const candidate of result.candidates)
        candidate.category = categoryFor(input, candidate, this.classifier.rules())
    const saved = approved
      ? (JSON.parse(approved.value) as { candidate: ResearchCandidate }).candidate
      : null
    const conflict = Boolean(
      saved &&
      result?.candidates.some(
        c =>
          c.sameVersion &&
          ((c.genre && saved.genre && normalize(c.genre) !== normalize(saved.genre)) ||
            (c.year && saved.year && (c.year !== saved.year || c.yearKind !== saved.yearKind)))
      )
    )
    return {
      result,
      conflict,
      stale: Boolean(
        row &&
        (!input ||
          row.signature !== signature(track) ||
          row.inputHash !== researchHash(input, row.provider))
      ),
      approved: approved
        ? {
            resultId: JSON.parse(approved.value).resultId,
            candidate: (JSON.parse(approved.value) as { candidate: ResearchCandidate }).candidate,
            current:
              approved.signature === signature(track) &&
              Boolean(input && approved.inputHash === digest(input)),
            approvedAt: approved.approvedAt,
          }
        : null,
    }
  }
  accept(args: { id: string; revision: number; resultId: string; candidate: number }) {
    const track = this.library.get(args.id),
      ev = this.track(args.id)
    if (!track || track.revision !== args.revision)
      throw new Error('The track changed. Refresh before approving research.')
    const result = ev.result,
      c = result?.candidates[args.candidate],
      input = researchInput(track)
    if (
      ev.stale ||
      result?.id !== args.resultId ||
      !c?.sameVersion ||
      !input ||
      (!c.genre && !c.year)
    )
      throw new Error('Only a current, matching version with cited values can be approved.')
    if (ev.approved)
      throw new Error('Clear the saved research choice explicitly before replacing it.')
    const existingEra = this.library.db
      .prepare('SELECT year,kind FROM era_years WHERE fileId=?')
      .get(track.id) as { year: number; kind: string } | undefined
    if (
      existingEra &&
      c.year &&
      ['recording', 'version'].includes(c.yearKind) &&
      (existingEra.year !== c.year || existingEra.kind !== c.yearKind)
    )
      throw new Error(
        'A saved era year differs. Clear that year explicitly in classification before approving this research.'
      )
    const approvedAt = new Date().toISOString()
    this.library.db.transaction(() => {
      this.library.db.prepare('INSERT INTO research_approved VALUES(?,?,?,?,?)').run(
        track.id,
        signature(track),
        digest(input),
        JSON.stringify({
          candidate: c,
          resultId: result.id,
          provider: result.provider,
          sources: c.sources,
        }),
        approvedAt
      )
      if (!existingEra && c.year && ['recording', 'version'].includes(c.yearKind))
        this.classifier.eraYear({
          id: track.id,
          revision: track.revision,
          year: c.year,
          kind: c.yearKind as 'recording' | 'version',
          note: `Research approval: ${result.id}`,
        })
      else this.library.db.prepare('UPDATE files SET revision=revision+1 WHERE id=?').run(track.id)
      this.library.db
        .prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?)')
        .run(
          randomUUID(),
          track.id,
          'research',
          null,
          JSON.stringify(c),
          approvedAt,
          track.revision + 1
        )
    })()
    if (this.classifier.state().automatic) this.classifier.start()
    this.notify()
  }
  clear(args: { id: string; revision: number }) {
    const track = this.library.get(args.id)
    if (!track || track.revision !== args.revision)
      throw new Error('Track changed. Refresh before clearing research.')
    const row = this.library.db
      .prepare('SELECT * FROM research_approved WHERE fileId=?')
      .get(args.id) as Approved | undefined
    if (!row) return
    const value = JSON.parse(row.value) as { resultId: string }
    this.library.db.transaction(() => {
      this.library.db.prepare('DELETE FROM research_approved WHERE fileId=?').run(args.id)
      const era = this.library.db
        .prepare('SELECT note FROM era_years WHERE fileId=?')
        .get(args.id) as { note: string } | undefined
      if (era?.note === `Research approval: ${value.resultId}`)
        this.classifier.eraYear({
          id: args.id,
          revision: args.revision,
          year: null,
          kind: 'recording',
          note: '',
        })
      else this.library.db.prepare('UPDATE files SET revision=revision+1 WHERE id=?').run(args.id)
      this.library.db
        .prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?)')
        .run(
          randomUUID(),
          args.id,
          'research',
          row.value,
          null,
          new Date().toISOString(),
          args.revision + 1
        )
    })()
    if (this.classifier.state().automatic) this.classifier.start()
    this.notify()
  }
  source(args: { id: string; resultId: string; url: string }) {
    const ev = this.track(args.id)
    const inResult =
      ev.result?.id === args.resultId &&
      ev.result.candidates.some(c => c.sources.some(s => s.url === args.url))
    const inApproved =
      ev.approved?.resultId === args.resultId &&
      ev.approved.candidate.sources.some(s => s.url === args.url)
    if (!publicSource(args.url) || (!inResult && !inApproved))
      throw new Error('Source link is not part of this research result.')
    return args.url
  }
}

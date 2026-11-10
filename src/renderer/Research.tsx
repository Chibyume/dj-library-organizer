import { useEffect, useRef, useState } from 'react'
import { Globe, Pause, ExternalLink } from 'lucide-react'
import type {
  ResearchImportPreview,
  ResearchPreview,
  ResearchState,
  ResearchEvidence,
  Track,
} from '../shared'
const api = window.organizer
type Run = (fn: () => Promise<unknown>) => Promise<boolean>
export function ResearchSettings({
  selected,
  run,
  busy,
}: {
  selected: Track[]
  run: Run
  busy: boolean
}) {
  const [scope, setScope] = useState<'selected' | 'review' | 'pending'>(
    selected.length ? 'selected' : 'review'
  )
  const [importPreview, setImportPreview] = useState<ResearchImportPreview | null>(null)
  const [imported, setImported] = useState<number | null>(null)
  const [limit, setLimit] = useState(10)
  const [state, setState] = useState<ResearchState | null>(null),
    [preview, setPreview] = useState<ResearchPreview | null>(null),
    [consent, setConsent] = useState(false),
    [localError, setLocalError] = useState<string | null>(null)
  const runHere: Run = fn =>
    run(async () => {
      setLocalError(null)
      try {
        return await fn()
      } catch (error) {
        setLocalError(error instanceof Error ? error.message : 'Research setup failed.')
        throw error
      }
    })
  const request = useRef(0)
  useEffect(() => {
    let alive = true
    const refresh = () => {
      void api
        .researchState()
        .then(s => {
          if (alive) setState(s)
        })
        .catch(e => {
          if (alive) setLocalError(e.message)
        })
    }
    refresh()
    const stop = api.onChange(e => {
      if (e.kind === 'research') refresh()
    })
    return () => {
      alive = false
      request.current++
      stop()
    }
  }, [])
  const running = state?.job?.status === 'running'
  const invalidate = () => {
    request.current++
    setPreview(null)
    setConsent(false)
  }
  async function plan() {
    const current = ++request.current
    setLocalError(null)
    setConsent(false)
    setPreview(null)
    try {
      const p = await api.researchPreview({
        provider: 'musicbrainz',
        scope,
        ids: selected.slice(0, 50).map(t => t.id),
        limit,
      })
      if (request.current === current) setPreview(p)
    } catch (e) {
      if (request.current === current)
        setLocalError(e instanceof Error ? e.message : 'Could not preview research.')
    }
  }
  return (
    <div className='research-settings'>
      <div className='eyebrow'>OPTIONAL ONLINE RESEARCH</div>
      <h2>
        <Globe size={23} /> Find a track's genre & year
      </h2>
      <p>
        Look up the specific recording or remix, compare sources, and propose its best library
        category. Review and approve researched values on each track. Your audio and embedded tags
        stay untouched.
      </p>
      <div className='research-job research-import'>
        <strong>Research prepared outside the app</strong>
        <p>
          Import a cited research file in one batch. Saved choices stay in place, changed tracks are
          held, and local classification uses the new evidence.
        </p>
        <button
          disabled={busy || running}
          className='button secondary'
          aria-label='Import research file'
          onClick={() =>
            void runHere(async () => {
              setImported(null)
              setImportPreview(await api.researchImportChoose())
            })
          }
        >
          Choose research file…
        </button>
        {imported !== null ? (
          <p role='status'>
            Imported research for {imported} tracks. Category conflicts still need review.
          </p>
        ) : null}
        {importPreview ? (
          <>
            <strong>{importPreview.label}</strong>
            <p>
              {importPreview.eligible} eligible of {importPreview.total} records
            </p>
            {Object.entries(importPreview.held).map(([reason, n]) => (
              <p key={reason}>
                {n}: {reason}
              </p>
            ))}
            <details>
              <summary>Preview findings and sources (up to 30 tracks)</summary>
              {importPreview.examples.map((e, i) => (
                <div key={i}>
                  <p>
                    <strong>
                      {e.artist} — {e.title}
                    </strong>
                    <br />
                    {e.genre || 'Genre unknown'} · {e.year || 'Year unknown'}
                  </p>
                  <p>{e.reasons.join(' ')}</p>
                  <small>{e.sources.map(s => s.url).join(' · ')}</small>
                </div>
              ))}
            </details>
            <button
              disabled={busy || running || !importPreview.eligible}
              className='button accent'
              aria-label='Apply imported research'
              onClick={() =>
                void runHere(async () => {
                  const result = await api.researchImportApply(importPreview.token)
                  setImported(result.imported)
                  setImportPreview(null)
                })
              }
            >
              Import {importPreview.eligible} researched records
            </button>
          </>
        ) : null}
      </div>
      <div className='research-provider'>
        <strong>MusicBrainz</strong>
        <span>Free recording database · no API key</span>
        <small>Useful for cataloged releases. Many DJ edits have no match.</small>
      </div>
      {state?.job ? (
        <div className='research-job' role='status'>
          <strong>Research {state.job.status}</strong>
          <span>
            {state.job.completed} completed · {state.job.cached} cached · {state.pending} pending ·{' '}
            {state.job.failed} failed
          </span>
          <p>{state.job.message}</p>
          {state.job.failedTrack ? (
            <p>
              Failed track: {state.job.failedTrack.title} · {state.job.failedTrack.artist}
            </p>
          ) : null}
          {state.job.failure ? (
            <small aria-label='Research failure diagnostic'>
              Diagnostic: {state.job.failure.kind}
              {state.job.failure.status ? ` · HTTP ${state.job.failure.status}` : ''}
            </small>
          ) : null}
          {running ? (
            <button
              className='button compact secondary'
              disabled={busy}
              onClick={() => void runHere(() => api.researchPause())}
            >
              <Pause size={13} /> Pause research
            </button>
          ) : null}
        </div>
      ) : null}
      <div className='research-batch'>
        <label>
          Research batch
          <select
            aria-label='Research scope'
            value={scope}
            disabled={running || busy}
            onChange={e => {
              setScope(e.target.value as typeof scope)
              invalidate()
            }}
          >
            <option value='selected'>Selected tracks ({Math.min(selected.length, 50)})</option>
            <option value='review'>Next unresolved tracks</option>
            <option value='pending'>Pending tracks from paused batch</option>
          </select>
        </label>
        <label>
          Track limit
          <input
            aria-label='Research track limit'
            type='number'
            min={1}
            max={50}
            value={limit}
            disabled={busy || running}
            onChange={e => {
              setLimit(Math.max(1, Math.min(50, Number(e.target.value) || 1)))
              invalidate()
            }}
          />
        </label>
        <button
          className='button secondary'
          aria-label='Preview research batch'
          disabled={busy || running || (scope === 'selected' && !selected.length)}
          onClick={() => void plan()}
        >
          Preview research batch
        </button>
      </div>
      {selected.length > 50 && scope === 'selected' ? (
        <p>Only the first 50 selected tracks are eligible for this batch.</p>
      ) : null}
      {localError ? (
        <p className='error-inline' role='alert'>
          {localError}
        </p>
      ) : null}
      {preview ? (
        <div className='research-preview'>
          <h3>Metadata sharing preview</h3>
          <p>
            {preview.tracks.length} eligible tracks · {preview.networkTracks} internet lookups ·{' '}
            {preview.tracks.length - preview.networkTracks} cached · {preview.skipped} skipped. At
            most {preview.maxRequests} HTTP requests including limited retries, at one per second.
          </p>
          <p>
            Only the title, artist, version text, duration, tagged year and tagged genre shown below
            are shared. Audio, local paths and XML collections stay on this Mac. Sources are
            retained locally for review. Cache lasts seven days.
          </p>
          <div className='research-share-list'>
            {preview.tracks.map(t => (
              <div key={t.id}>
                <strong>
                  {t.input.title} — {t.input.artist}
                </strong>
                <small>
                  {t.input.version ? `Version: ${t.input.version} · ` : ''}
                  {t.input.duration == null
                    ? 'Unknown duration'
                    : `${Math.round(t.input.duration)}s`}{' '}
                  · Tagged year: {t.input.taggedYear || 'unknown'} · Genre:{' '}
                  {t.input.taggedGenre || 'unknown'}
                  {t.cached ? ' · cached' : ''}
                </small>
              </div>
            ))}
          </div>
          <label className='research-consent'>
            <input
              aria-label='Allow previewed metadata lookup'
              type='checkbox'
              checked={consent}
              onChange={e => setConsent(e.target.checked)}
            />{' '}
            Allow this batch to send the previewed metadata to MusicBrainz.
          </label>
          <button
            className='button accent'
            aria-label='Start previewed research'
            disabled={busy || running || !consent || !preview.tracks.length}
            onClick={() => {
              const token = preview.token
              void runHere(async () => {
                await api.researchStart(token)
                setPreview(null)
                setConsent(false)
                setState(await api.researchState())
              })
            }}
          >
            Start research
          </button>
        </div>
      ) : null}
      <p className='evidence-note'>
        Missing embedded titles or artists are skipped. Uncertain versions and unsupported claims
        remain for review. Batch results appear in each track's Online research section. Category
        suggestions organize the app's library; this version does not move files into physical
        folders.
      </p>
    </div>
  )
}
export function TrackResearch({
  track,
  generation,
  busy,
  run,
  onOpen,
}: {
  track: Track
  generation: number
  busy: boolean
  run: Run
  onOpen: () => void
}) {
  const [evidence, setEvidence] = useState<ResearchEvidence | null>(null),
    [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setEvidence(null)
    void api
      .researchTrack(track.id)
      .then(e => {
        if (alive) {
          setEvidence(e)
          setError(null)
        }
      })
      .catch(e => {
        if (alive) setError(e.message)
      })
    return () => {
      alive = false
    }
  }, [track.id, track.revision, generation])
  const result = evidence?.result
  return (
    <section className='panel-section track-research'>
      <h3>
        <Globe size={15} /> Online research
      </h3>
      <button className='text-button' onClick={onOpen}>
        Research this track or a batch
      </button>
      {error ? <p role='alert'>{error}</p> : null}
      {evidence?.approved ? (
        <div className='research-approved'>
          <strong>
            {evidence.approved.current ? 'Saved research choice' : 'Saved research needs recheck'}
          </strong>
          <p>
            {evidence.approved.candidate.genre || 'Genre unknown'} ·{' '}
            {evidence.approved.candidate.date || 'Year unknown'} (
            {evidence.approved.candidate.yearKind})
          </p>
          <details>
            <summary>Saved research evidence and sources</summary>
            {evidence.approved.candidate.reasons.map((reason, i) => (
              <p className='field-help' key={i}>
                {reason}
              </p>
            ))}
            <div className='research-sources'>
              {evidence.approved.candidate.sources.map(source => (
                <button
                  className='text-button'
                  key={source.url}
                  onClick={() =>
                    void run(() =>
                      api.researchSource(track.id, evidence.approved!.resultId, source.url)
                    )
                  }
                >
                  {source.title}
                </button>
              ))}
            </div>
          </details>
          <button
            className='text-button'
            disabled={busy}
            onClick={() => void run(() => api.researchClear(track.id, track.revision))}
          >
            Clear saved research
          </button>
        </div>
      ) : null}
      {evidence?.conflict ? (
        <p className='error-inline' role='status'>
          New research conflicts with your saved research choice. Compare the sources; your saved
          choice is preserved.
        </p>
      ) : null}
      {result ? (
        <>
          <p className='evidence-note'>
            MusicBrainz · Retrieved {new Date(result.retrievedAt).toLocaleDateString()}
            {evidence?.stale ? ' · stale: track metadata changed' : ''}
          </p>
          {result.notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
          {result.candidates.map((c, i) => (
            <article className='research-candidate' key={i}>
              <strong>{c.title}</strong>
              <span>{c.artist}</span>
              <dl>
                <div>
                  <dt>Genre</dt>
                  <dd>{c.genre || 'Unknown'}</dd>
                </div>
                <div>
                  <dt>Date</dt>
                  <dd>
                    {c.date || 'Unknown'} · {c.yearKind}
                  </dd>
                </div>
                <div>
                  <dt>Best category</dt>
                  <dd>{c.category || 'Needs review'}</dd>
                </div>
              </dl>
              <p>
                {c.sameVersion
                  ? 'Recording/version match proposed'
                  : 'Version identity needs review'}
              </p>
              <details>
                <summary>Matching evidence & uncertainty</summary>
                {c.reasons.map((r, j) => (
                  <p key={j}>{r}</p>
                ))}
              </details>
              <div className='research-sources'>
                {c.sources.map(s => (
                  <button
                    className='text-button'
                    key={s.url}
                    title={s.url}
                    disabled={busy}
                    onClick={() => void run(() => api.researchSource(track.id, result.id, s.url))}
                  >
                    <ExternalLink size={12} />
                    {s.title}
                  </button>
                ))}
              </div>
              <button
                className='button compact secondary'
                aria-label={`Approve researched values ${i + 1}`}
                disabled={
                  busy ||
                  Boolean(evidence?.approved) ||
                  evidence?.stale ||
                  !c.sameVersion ||
                  (!c.genre && !c.year)
                }
                onClick={() =>
                  void run(() => api.researchAccept(track.id, track.revision, result.id, i))
                }
              >
                Approve researched values
              </button>
              <small>
                Approval saves a local genre and eligible recording/version year. Existing manual
                categories stay protected. Album/reissue years do not set the era.
              </small>
            </article>
          ))}
        </>
      ) : (
        <p className='evidence-note'>
          {evidence?.approved
            ? 'Saved research is shown above. You can optionally preview a MusicBrainz batch for another lookup.'
            : 'No saved research yet. Preview a batch before sending metadata to MusicBrainz.'}
        </p>
      )}
    </section>
  )
}

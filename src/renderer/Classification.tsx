import { useEffect, useRef, useState } from 'react'
import { Sparkles, Pause, Play, Check, CircleAlert, Trash2 } from 'lucide-react'
import {
  MUSIC_CATEGORIES,
  type Category,
  type ClassificationEvidence,
  type ClassificationRule,
  type ClassificationState,
  type RuleDraft,
  type RulePreview,
  type Track,
} from '../shared'
const api = window.organizer

export function ClassificationStrip({
  state,
  busy,
  onOpen,
  run,
}: {
  state: ClassificationState | null
  busy: boolean
  onOpen: () => void
  run: (fn: () => Promise<unknown>) => Promise<boolean>
}) {
  const running = state?.lastJob?.status === 'running'
  return (
    <div className='classification-strip'>
      <Sparkles size={18} />
      <div>
        <strong>
          {!state
            ? 'Preparing classification…'
            : state.lastJob?.status === 'failed'
              ? 'Classification needs attention'
              : running
                ? 'Classifying your library…'
                : state?.automatic
                  ? 'Automatic classification is on'
                  : 'Automatic classification is paused'}
        </strong>
        <span>
          {running
            ? `${state?.lastJob?.processed.toLocaleString()} checked · ${state?.pending.toLocaleString()} queued`
            : `${state?.ready.toLocaleString() || 0} ready placements · ${state?.unresolved.toLocaleString() || 0} need review`}
          {state?.conflicts ? ` · ${state.conflicts} conflict with saved choices` : ''}
        </span>
      </div>
      <button
        className='button compact secondary'
        disabled={busy || !state}
        onClick={() =>
          void run(() => api.classificationAutomatic(running ? false : !state?.automatic))
        }
      >
        {state?.automatic || running ? <Pause size={13} /> : <Play size={13} />}
        {state?.automatic || running ? 'Pause' : 'Resume'}
      </button>
      <button className='text-button' onClick={onOpen}>
        Rules & details
      </button>
    </div>
  )
}

export function ClassificationSettings({
  state,
  run,
  busy,
}: {
  state: ClassificationState | null
  run: (fn: () => Promise<unknown>) => Promise<boolean>
  busy: boolean
}) {
  const previewRequest = useRef(0)
  const [rules, setRules] = useState<ClassificationRule[]>([]),
    [draft, setDraft] = useState<RuleDraft>({
      field: 'genre',
      match: '',
      category: 'Jersey Club',
    }),
    [preview, setPreview] = useState<RulePreview | null>(null),
    [working, setWorking] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const refresh = () =>
      void api
        .classificationRules()
        .then(r => {
          if (alive) setRules(r)
        })
        .catch(e => {
          if (alive) setError(e.message)
        })
    refresh()
    const unsubscribe = api.onChange(event => {
      if (event.kind === 'library') refresh()
    })
    return () => {
      alive = false
      unsubscribe()
      previewRequest.current++
      void api.classificationRuleCancel().catch(() => {})
    }
  }, [])
  function edit(next: Partial<RuleDraft>) {
    previewRequest.current++
    setDraft(old => ({ ...old, ...next }))
    setPreview(null)
    setError('')
  }
  async function previewRule() {
    const request = ++previewRequest.current
    setWorking(true)
    setError('')
    setPreview(null)
    try {
      const result = await api.classificationRulePreview(draft)
      if (previewRequest.current === request) setPreview(result)
    } catch (e) {
      if (previewRequest.current === request)
        setError(e instanceof Error ? e.message : 'Preview failed.')
    } finally {
      if (previewRequest.current === request) setWorking(false)
    }
  }
  return (
    <>
      <div className='eyebrow'>LOCAL CATEGORY SUGGESTIONS</div>
      <h2>Automatic classification</h2>
      <p>
        Clear genre tags and explicit remix styles produce suggestions in your categories. Uncertain
        tracks stay in Review. Suggestions are ready for approval; running again never approves
        them.
      </p>
      <label className='classification-toggle'>
        <input
          type='checkbox'
          role='switch'
          className='toggle-switch'
          checked={state?.automatic || false}
          disabled={busy || !state}
          onChange={e => void run(() => api.classificationAutomatic(e.target.checked))}
        />
        Automatically classify this catalog after scans and XML imports
      </label>
      <p className='field-help'>
        Processes locally stored metadata while the app is open. No audio upload, external lookup,
        file move, or tag write. Your saved categories, exclusions and review decisions are
        preserved.
      </p>
      <div className='classification-stats'>
        <div>
          <strong>{state?.ready.toLocaleString() || 0}</strong>
          <span>Ready suggestions</span>
        </div>
        <div>
          <strong>{state?.unresolved.toLocaleString() || 0}</strong>
          <span>Need review</span>
        </div>
        <div>
          <strong>{state?.pending.toLocaleString() || 0}</strong>
          <span>Queued files</span>
        </div>
      </div>
      {state?.lastJob?.error ? (
        <p className='track-error' role='alert'>
          {state.lastJob.error}
        </p>
      ) : null}
      <button
        className='button secondary'
        disabled={busy || state?.lastJob?.status === 'running'}
        onClick={() => void run(() => api.classificationRun())}
      >
        <Sparkles size={15} />
        Classify library now
      </button>
      {state?.lastJob?.status === 'running' ? (
        <button
          className='text-button'
          disabled={busy}
          onClick={() => void run(() => api.classificationAutomatic(false))}
        >
          Pause processing
        </button>
      ) : null}
      <p className='field-help'>
        Reggaeton Old uses 2007 and earlier; Reggaeton New uses 2008 and later. Confirm the relevant
        recording or remix year in Track Details. An album tag alone may describe a later reissue.
        You can export general Reggaeton playlists while the era is unconfirmed.
      </p>
      <h3>Your classification rules</h3>
      <p className='field-help'>
        Map an exact genre value, or a specific title/filename phrase, to a category. Matching rules
        take precedence over defaults. Conflicting rules require review. Manual choices remain
        protected.
      </p>
      <form
        className='rule-form'
        onSubmit={event => {
          event.preventDefault()
          void previewRule()
        }}
      >
        <label>
          Evidence
          <select
            disabled={working || busy}
            value={draft.field}
            onChange={e => edit({ field: e.target.value as RuleDraft['field'] })}
          >
            <option value='genre'>Exact genre value</option>
            <option value='versionLabel'>Title / filename phrase</option>
          </select>
        </label>
        <label>
          Match
          <input
            disabled={working || busy}
            aria-label='Rule match'
            maxLength={120}
            minLength={3}
            required
            value={draft.match}
            onChange={e => edit({ match: e.target.value })}
            placeholder={draft.field === 'genre' ? 'e.g. Club Music' : 'e.g. Jersey Club Remix'}
          />
        </label>
        <label>
          Propose category
          <select
            disabled={working || busy}
            value={draft.category}
            onChange={e => edit({ category: e.target.value as Category })}
          >
            {MUSIC_CATEGORIES.map(c => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <button
          className='button secondary'
          type='submit'
          disabled={working || busy || draft.match.trim().length < 3}
        >
          {working ? 'Checking library…' : 'Preview rule'}
        </button>
      </form>
      {working ? (
        <button
          className='text-button'
          onClick={() => void api.classificationRuleCancel().catch(e => setError(e.message))}
        >
          Cancel preview
        </button>
      ) : null}
      {error ? (
        <p className='track-error' role='alert'>
          {error}
        </p>
      ) : null}
      {preview ? (
        <div className='rule-preview' role='region' aria-label='Rule preview'>
          <strong>
            {preview.affected.toLocaleString()} matching files ·{' '}
            {preview.protected.toLocaleString()} manual choices protected ·{' '}
            {preview.conflicts.toLocaleString()} conflicts
          </strong>
          {preview.examples.map(e => (
            <div className='rule-example' key={e.id}>
              <span>
                {e.title}
                <small>{e.artist}</small>
              </span>
              <span>
                {e.manual ? `Keep ${e.current || 'unclassified'}` : e.proposed || 'Needs review'}
                <small>
                  {e.status}
                  {e.manual ? ' · protected' : ''}
                </small>
              </span>
            </div>
          ))}
          {preview.affected > 20 ? (
            <p className='field-help'>Showing 20 examples. Counts include every matching file.</p>
          ) : null}
          <button
            className='button accent'
            disabled={busy || working}
            onClick={async () => {
              if (await run(() => api.classificationRuleSave(preview.token))) {
                setPreview(null)
                setDraft(old => ({ ...old, match: '' }))
              }
            }}
          >
            <Check size={15} />
            Save previewed rule
          </button>
        </div>
      ) : null}
      {rules.map(rule => (
        <div className='saved-rule' key={rule.id}>
          <div>
            <strong>
              {rule.match} → {rule.category}
            </strong>
            <small>
              {rule.field === 'genre' ? 'Exact genre value' : 'Title / filename phrase'}
            </small>
          </div>
          <button
            className='icon-button'
            aria-label={`Remove rule ${rule.match}`}
            disabled={busy}
            onClick={() => void run(() => api.classificationRuleRemove(rule.id))}
          >
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      {!rules.length ? (
        <p className='field-help'>
          No custom rules yet. A correction to one track never creates an artist rule.
        </p>
      ) : null}
    </>
  )
}

export function TrackClassification({
  track,
  generation,
  run,
  busy,
}: {
  track: Track
  generation: number
  run: (fn: () => Promise<unknown>) => Promise<boolean>
  busy: boolean
}) {
  const [evidence, setEvidence] = useState<ClassificationEvidence | null>(null),
    [error, setError] = useState(''),
    [year, setYear] = useState(''),
    [kind, setKind] = useState<'recording' | 'version'>('recording'),
    [note, setNote] = useState('')
  useEffect(() => {
    let alive = true
    setError('')
    void api
      .classificationTrack(track.id)
      .then(e => {
        if (alive) setEvidence(e)
      })
      .catch(e => {
        if (alive) setError(e.message)
      })
    return () => {
      alive = false
    }
  }, [track.id, track.revision, generation])
  const reggaeton =
    evidence?.genre === 'Reggaeton' ||
    track.genre?.toLowerCase().includes('reggaeton') ||
    track.category?.startsWith('Reggaeton')
  return (
    <div className='panel-section classification-evidence'>
      <div className='field-label'>AUTOMATIC CLASSIFICATION</div>
      {error ? (
        <p className='track-error' role='alert'>
          {error}
        </p>
      ) : !evidence ? (
        <p className='field-help'>
          Queued for local classification. Open Rules & details to start or resume.
        </p>
      ) : (
        <>
          <div className='proposal-label'>
            <Sparkles size={15} />
            <strong>
              {evidence.stale ? 'Evidence changed · queued' : evidence.category || evidence.status}
            </strong>
          </div>
          <p className='field-help'>
            {track.manual
              ? 'Your saved choice is protected.'
              : evidence.status === 'Ready for Approval'
                ? 'Placed in this category · ready for batch approval.'
                : 'Tentative placement · needs your review before export.'}{' '}
            {evidence.genre ? `Genre evidence: ${evidence.genre}.` : ''}
          </p>
          {evidence.manualConflict && !evidence.stale ? (
            <p className='track-error'>
              <CircleAlert size={13} /> New evidence differs from your saved decision. Keep your
              category or choose another below.
            </p>
          ) : null}
          {evidence.reasons.map((reason, i) => (
            <p className='field-help' key={i}>
              {reason}
            </p>
          ))}
          {evidence.status !== 'Ready for Approval' && evidence.candidates.length > 1 ? (
            <p className='field-help'>Candidates: {evidence.candidates.join(' · ')}</p>
          ) : null}
          <details>
            <summary>Why this suggestion?</summary>
            {evidence.evidence.map((e, i) => (
              <div className='classification-source' key={i}>
                <strong>{e.source}</strong>
                <span>{e.value}</span>
                <small>{e.meaning}</small>
              </div>
            ))}
            {!evidence.evidence.length ? (
              <p className='field-help'>No usable genre evidence.</p>
            ) : null}
          </details>
          {reggaeton ? (
            <details className='era-form' open={!evidence.era?.current}>
              <summary>Confirm the year for this recording / version</summary>
              {evidence.era ? (
                <p className='field-help'>
                  {evidence.era.current ? 'Confirmed' : 'Needs reconfirmation'}: {evidence.era.year}{' '}
                  · {evidence.era.kind}
                  {evidence.era.note ? ` · ${evidence.era.note}` : ''}
                </p>
              ) : null}
              <form
                onSubmit={event => {
                  event.preventDefault()
                  void run(() => api.eraYear(track.id, track.revision, Number(year), kind, note))
                }}
              >
                <label>
                  Year
                  <input
                    aria-label='Confirmed era year'
                    required
                    type='number'
                    min={1900}
                    max={2100}
                    value={year}
                    onChange={e => setYear(e.target.value)}
                    placeholder='Verified release year'
                  />
                </label>
                <label>
                  Applies to
                  <select
                    value={kind}
                    onChange={e => setKind(e.target.value as 'recording' | 'version')}
                  >
                    <option value='recording'>This recording's earliest release</option>
                    <option value='version'>This remix / edit version</option>
                  </select>
                </label>
                <label>
                  Source / note
                  <input
                    aria-label='Era year source note'
                    value={note}
                    maxLength={300}
                    onChange={e => setNote(e.target.value)}
                    placeholder='Optional release reference'
                  />
                </label>
                <button className='button secondary' type='submit' disabled={busy || !year}>
                  Confirm era year
                </button>
              </form>
              {evidence.era ? (
                <button
                  className='text-button'
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.eraYear(track.id, track.revision, null, kind, ''))
                  }
                >
                  Clear confirmed year
                </button>
              ) : null}
              <p className='field-help'>
                For a later reissue, confirm the original recording's earliest release. For a later
                remix, confirm this version's year. This changes only the local era evidence.
              </p>
            </details>
          ) : null}
        </>
      )}
    </div>
  )
}

import { PreparationTrack } from './PreparationTrack'
import { DuplicateCleanup } from './DuplicateCleanup'
import { ExportVerification } from './ExportVerification'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DuplicateJob,
  DuplicatePage,
  ExportRecord,
  PreparationPage,
  PreparationPreview,
  DuplicateMember,
} from '../preparation-types'
const api = window.organizer
export function Preparation({
  selected,
  onPreview,
  onRefreshXML,
  onReview,
}: {
  selected: string[]
  onRefreshXML: () => void
  onPreview: (member: DuplicateMember) => Promise<void>
  onReview: (reason?: string) => void
}) {
  const [replaceChoices, setReplaceChoices] = useState(false)
  const [duplicates, setDuplicates] = useState<DuplicatePage | null>(null)
  const [memberPages, setMemberPages] = useState<
    Record<string, { offset: number; members: DuplicateMember[] }>
  >({})
  const [job, setJob] = useState<DuplicateJob | null>(null)
  const [offset, setOffset] = useState(0)
  const [scope, setScope] = useState<'all' | 'selected'>('all')
  const [plan, setPlan] = useState<PreparationPreview | null>(null)
  const [page, setPage] = useState<PreparationPage | null>(null)
  const [pageOffset, setPageOffset] = useState(0)
  const [filter, setFilter] = useState<'all' | 'eligible' | 'blocked'>('eligible')
  const [reason, setReason] = useState('')
  const [history, setHistory] = useState<ExportRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const mounted = useRef(true)
  const lastJobStatus = useRef<string | undefined>(undefined)
  const groupRequest = useRef(0)
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])
  const load = useCallback(async () => {
    const request = ++groupRequest.current
    const [d, h] = await Promise.all([api.duplicateList(offset), api.preparationHistory()])
    if (mounted.current && request === groupRequest.current) {
      setDuplicates(d)
      setJob(d.job)
      setHistory(h)
    }
  }, [offset])
  useEffect(() => {
    mounted.current = true
    void load().catch(e => setError(e.message))
    return () => {
      mounted.current = false
    }
  }, [load])
  useEffect(() => {
    let pending = false
    const timer = setInterval(() => {
      if (pending) return
      pending = true
      void api
        .duplicateState()
        .then(async current => {
          if (!mounted.current) return
          setJob(current)
          if (lastJobStatus.current === 'running' && current?.status !== 'running') await load()
          lastJobStatus.current = current?.status
        })
        .catch(e => {
          if (mounted.current) setError(e.message)
        })
        .finally(() => {
          pending = false
        })
    }, 1000)
    return () => clearInterval(timer)
  }, [load])
  useEffect(() => {
    if (!plan) {
      setPage(null)
      return
    }
    let stale = false
    setPage(null)
    void api
      .preparationPage(plan.token, pageOffset, filter, reason || undefined)
      .then(p => {
        if (!stale) setPage(p)
      })
      .catch(e => {
        if (!stale) setError(e.message)
      })
    return () => {
      stale = true
    }
  }, [plan, pageOffset, filter, reason])
  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Preparation failed.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  async function preview() {
    const p = await api.preparationPreview({
      scope,
      ids: scope === 'selected' ? selected : [],
    })
    setPlan(p)
    setPageOffset(0)
    setReason('')
  }
  function showHeld(nextReason = '') {
    setFilter('blocked')
    setReason(nextReason)
    setPageOffset(0)
  }
  const hashing = job?.status === 'running'
  return (
    <div className='prepare-workflow'>
      <div className='eyebrow'>FROM LIBRARY TO DECKS</div>
      <h2>Prepare for rekordbox</h2>
      <p className='muted'>
        Pick the best copies in bulk, approve categories, and save playlists for rekordbox.
        Duplicate cleanup is a separate recoverable Trash action.
      </p>
      {error ? (
        <div className='message error' role='alert'>
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className='message success' role='status'>
          {notice}
        </div>
      ) : null}
      {busy ? (
        <div className='prepare-working' role='status'>
          Preparing…{' '}
          <button
            className='button secondary'
            onClick={() => void api.preparationCancel().catch(e => setError(e.message))}
          >
            Cancel preparation
          </button>
        </div>
      ) : null}
      <section className='prepare-step'>
        <div className='prepare-step-heading'>
          <div>
            <span className='eyebrow'>STEP 1</span>
            <h3>Choose the copies you want to play</h3>
          </div>
          <button
            className='button secondary'
            id='duplicate-run'
            disabled={busy || cleaning}
            onClick={() =>
              void run(async () => {
                setPlan(null)
                if (hashing) await api.duplicatePause()
                else await api.duplicateRun()
                setJob(await api.duplicateState())
                lastJobStatus.current = hashing ? 'paused' : 'running'
              })
            }
          >
            {hashing ? 'Pause check' : 'Check duplicates'}
          </button>
        </div>
        <p>
          Full-file SHA-256 finds identical copies. Matching artist and title also flags candidates;
          this does not detect every differently tagged copy. Clean, explicit, intro, remix and
          other version labels stay visible.
        </p>
        <label>
          <input
            type='checkbox'
            checked={replaceChoices}
            disabled={busy || hashing || cleaning}
            onChange={e => setReplaceChoices(e.target.checked)}
          />{' '}
          Re-pick previously saved copy choices too
        </label>
        <div className='prepare-actions'>
          <button
            className='button primary'
            disabled={busy || hashing || cleaning || Boolean(duplicates?.unchecked)}
            onClick={() =>
              void run(async () => {
                const result = await api.duplicateAutoChoose({
                  replaceExisting: replaceChoices,
                })
                setPlan(null)
                setMemberPages({})
                setNotice(
                  `Best copies selected: ${result.exactGroups} identical groups and ${result.candidateGroups} matching-title groups. ${result.preservedChoices} saved choices preserved; ${result.versionsKept} uncertain groups kept as separate versions. No files deleted.`
                )
                await load()
              })
            }
          >
            Pick best copies for me
          </button>
        </div>
        <p>
          Keeps the copy with the most exact Rekordbox collection references. Ties use playlist
          appearances, cues, audio quality, then library location. Existing choices stay saved
          unless you re-pick them. Uncertain versions stay separate. You can inspect or change any
          choice below.
        </p>
        {job ? (
          <p role='status'>
            <strong>{job.status === 'running' ? 'Checking files' : `Check ${job.status}`}</strong> ·{' '}
            {job.checked} of {job.total} checked · {job.cached} reused · {job.failed} failed{' '}
            {job.current ? `· ${job.current}` : ''}
            {job.error ? ` · ${job.error}` : ''}
          </p>
        ) : null}
        {duplicates ? (
          <p>
            {duplicates.unchecked} files still need a successful check · {duplicates.unresolved}{' '}
            groups need your decision
          </p>
        ) : null}
        {duplicates?.groups.map(group => (
          <details className='duplicate-group' key={group.key} open={!group.resolved}>
            <summary>
              {group.kind === 'exact'
                ? 'Identical file copies'
                : 'Possible duplicates / separate versions'}{' '}
              · {group.memberCount} files · {group.resolved ? 'Reviewed' : 'Review needed'}
            </summary>
            <p>
              {group.kind === 'exact'
                ? 'These files have the same complete-file hash.'
                : 'Only the artist and full title match. Listen and compare before choosing.'}{' '}
              Your choice controls playlist inclusion; every file remains in place.
            </p>
            <div className='duplicate-members'>
              {(memberPages[group.fingerprint]?.members || group.members).map(member => (
                <article className='duplicate-member' key={member.track.id}>
                  <strong>{member.track.title || member.track.filename}</strong>
                  <span>{member.track.artist || 'Unknown artist'}</span>
                  <code>{member.track.path}</code>
                  <p>
                    {member.track.format || 'Unknown format'} ·{' '}
                    {member.track.duration?.toFixed(0) || '?'} sec ·{' '}
                    {member.track.bitrate
                      ? `${Math.round(member.track.bitrate / 1000)} kbps`
                      : 'Bitrate unknown'}{' '}
                    · {member.track.sampleRate || '?'} Hz
                  </p>
                  <p>
                    {member.references} exact rekordbox references ·{' '}
                    {member.playlistReferences || 0} playlist appearances · {member.cues} cue/loop
                    markers · {member.grids} grid entries
                  </p>
                  {group.recommendation === member.track.id ? (
                    <p className='keeper-hint'>
                      Suggested keeper: the only copy referenced in your snapshot.
                    </p>
                  ) : null}
                  <div className='prepare-actions'>
                    <button
                      className='button secondary'
                      disabled={busy || cleaning}
                      onClick={() => void run(() => onPreview(member))}
                    >
                      Listen
                    </button>
                    <button
                      className='button secondary'
                      disabled={busy || cleaning}
                      onClick={() => void run(() => api.reveal(member.track.id))}
                    >
                      Show file
                    </button>
                    <button
                      className='button accent'
                      disabled={busy || hashing || cleaning}
                      onClick={() =>
                        void run(async () => {
                          await api.duplicateResolve(group.key, group.fingerprint, member.track.id)
                          setPlan(null)
                          await load()
                        })
                      }
                    >
                      {group.keeper === member.track.id
                        ? 'Chosen for playlists'
                        : 'Use only this copy'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {group.memberCount > 50 ? (
              <div className='prepare-actions'>
                <button
                  className='button secondary'
                  disabled={busy || !memberPages[group.fingerprint]?.offset}
                  onClick={() =>
                    void run(async () => {
                      const offset = (memberPages[group.fingerprint]?.offset || 0) - 50
                      const members = await api.duplicateMembers(
                        group.key,
                        group.fingerprint,
                        offset
                      )
                      setMemberPages(p => ({
                        ...p,
                        [group.fingerprint]: { offset, members },
                      }))
                    })
                  }
                >
                  Previous copies
                </button>
                <span>
                  {(memberPages[group.fingerprint]?.offset || 0) + 1}–
                  {Math.min((memberPages[group.fingerprint]?.offset || 0) + 50, group.memberCount)}{' '}
                  of {group.memberCount}
                </span>
                <button
                  className='button secondary'
                  disabled={
                    busy || (memberPages[group.fingerprint]?.offset || 0) + 50 >= group.memberCount
                  }
                  onClick={() =>
                    void run(async () => {
                      const offset = (memberPages[group.fingerprint]?.offset || 0) + 50
                      const members = await api.duplicateMembers(
                        group.key,
                        group.fingerprint,
                        offset
                      )
                      setMemberPages(p => ({
                        ...p,
                        [group.fingerprint]: { offset, members },
                      }))
                    })
                  }
                >
                  Next copies
                </button>
              </div>
            ) : null}
            <button
              className='button secondary'
              disabled={busy || hashing || cleaning}
              onClick={() =>
                void run(async () => {
                  await api.duplicateResolve(group.key, group.fingerprint, null)
                  setPlan(null)
                  await load()
                })
              }
            >
              {group.kind === 'exact'
                ? 'Keep all copies in playlists'
                : 'Keep all as separate versions'}
            </button>
          </details>
        ))}
        {duplicates && duplicates.total > 10 ? (
          <div className='prepare-actions'>
            <button
              className='button secondary'
              disabled={offset === 0 || busy || cleaning}
              onClick={() => setOffset(n => Math.max(0, n - 10))}
            >
              Previous groups
            </button>
            <span>
              {offset + 1}–{Math.min(offset + 10, duplicates.total)} of {duplicates.total}
            </span>
            <button
              className='button secondary'
              disabled={offset + 10 >= duplicates.total || busy || cleaning}
              onClick={() => setOffset(n => n + 10)}
            >
              Next groups
            </button>
          </div>
        ) : null}
      </section>
      <DuplicateCleanup
        disabled={busy || hashing}
        onRunning={setCleaning}
        onDone={() => {
          setPlan(null)
          setMemberPages({})
          void load().catch(e => setError(e.message))
        }}
      />
      <section className='prepare-step'>
        <span className='eyebrow'>STEP 2</span>
        <h3>Approve the eligible classifications together</h3>
        <p>
          Eligible means a settled performance category, confirmed Reggaeton era for Old/New
          playlists, a complete source scan, checked files, and resolved duplicate and identity
          conflicts. Unconfirmed eras use general Reggaeton. Exact-path Rekordbox metadata, cues and
          grids are retained when ordinary tags differ. Your approval is saved in this app.
        </p>
        <div className='prepare-actions'>
          <label>
            Batch{' '}
            <select
              aria-label='Playlist preparation scope'
              value={scope}
              disabled={busy || cleaning}
              onChange={e => {
                setScope(e.target.value as typeof scope)
                setPlan(null)
              }}
            >
              <option value='all'>All catalog tracks</option>
              <option value='selected' disabled={!selected.length}>
                Selected tracks ({selected.length})
              </option>
            </select>
          </label>
          <button
            className='button secondary'
            id='preparation-preview'
            disabled={busy || hashing || cleaning}
            onClick={() => void run(preview)}
          >
            Preview all tracks
          </button>
        </div>
        {plan ? (
          <>
            <div className='prepare-stats'>
              <div>
                <strong>{plan.total}</strong>catalog entries
              </div>
              <div>
                <strong>{plan.eligible}</strong>eligible
              </div>
              <div>
                <strong>{plan.approved}</strong>approved
              </div>
              <div>
                <strong>{plan.blocked}</strong>held for review
              </div>
            </div>
            <div className='prepare-categories'>
              {Object.entries(plan.categories).map(([name, n]) => (
                <span key={name}>
                  {name} <strong>{n}</strong>
                </span>
              ))}
            </div>
            {plan.blocked ? (
              <div className='prepare-held'>
                <button
                  className='button secondary'
                  id='preparation-review-held'
                  disabled={busy || cleaning}
                  onClick={() => onReview('held')}
                >
                  Open {plan.blocked} held tracks in Review
                </button>
                <p className='field-help'>
                  Held entries include extra copies, workflow categories and unavailable files.
                  Review shows these same reasons and lets you edit tags and categories in one
                  place. A category change cannot repair a file or resolve an ambiguous Rekordbox
                  match.
                </p>
                <div className='prepare-actions' aria-label='Reasons tracks are held'>
                  {Object.entries(plan.reasons).map(([heldReason, n]) => (
                    <button
                      className='text-button'
                      key={heldReason}
                      disabled={busy || cleaning}
                      onClick={() => onReview(heldReason)}
                    >
                      {n} — {heldReason}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <p>
              {plan.known} already referenced in the snapshot · {plan.newToSnapshot} not matched to
              it.{' '}
              {plan.snapshotAt
                ? `Snapshot imported ${new Date(plan.snapshotAt).toLocaleString()}.`
                : 'No rekordbox snapshot connected; existing collection membership is unknown.'}
            </p>
            <div className='prepare-actions'>
              <label>
                Preview{' '}
                <select
                  aria-label='Preparation track filter'
                  value={filter}
                  disabled={busy || cleaning}
                  onChange={e => {
                    setFilter(e.target.value as typeof filter)
                    setPageOffset(0)
                    setReason('')
                  }}
                >
                  <option value='eligible'>Eligible tracks</option>
                  <option value='blocked'>Held tracks</option>
                  <option value='all'>All tracks</option>
                </select>
              </label>
              {filter === 'blocked' ? (
                <label>
                  Reason{' '}
                  <select
                    aria-label='Held reason'
                    value={reason}
                    disabled={busy || cleaning}
                    onChange={event => showHeld(event.target.value)}
                  >
                    <option value=''>All reasons</option>
                    {Object.keys(plan.reasons).map(value => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <button
                className='button accent'
                id='preparation-approve'
                disabled={busy || cleaning || hashing || plan.needsApproval === 0}
                onClick={() =>
                  void run(async () => {
                    await api.preparationApprove(plan.token)
                    await preview()
                    setNotice('Eligible classifications approved. Save the playlists below.')
                  })
                }
              >
                Approve {plan.needsApproval} classifications
              </button>
            </div>
            {plan.needsApproval === 0 ? (
              <p className='field-help'>
                All eligible tracks are already approved. Held tracks need the action shown beside
                them before they can be included.
              </p>
            ) : null}
            <p className='field-help'>
              Edit tags and categories in Library Review, then return here to preview and approve
              the eligible batch. Original files stay untouched.
            </p>
            <div className='prepare-track-list' aria-busy={!page || busy}>
              {!page ? (
                <p role='status'>Loading tracks…</p>
              ) : !page.items.length ? (
                <p>No tracks in this view.</p>
              ) : (
                page.items.map(item => (
                  <PreparationTrack
                    key={`${plan.token}:${item.id}`}
                    item={item}
                    busy={busy || cleaning || hashing}
                    onReview={onReview}
                  />
                ))
              )}
            </div>
            {page && page.total > 50 ? (
              <div className='prepare-actions'>
                <button
                  className='button secondary'
                  disabled={busy || cleaning || pageOffset === 0}
                  onClick={() => setPageOffset(n => n - 50)}
                >
                  Previous tracks
                </button>
                <span>
                  {pageOffset + 1}–{Math.min(pageOffset + 50, page.total)} of {page.total}
                </span>
                <button
                  className='button secondary'
                  disabled={busy || cleaning || pageOffset + 50 >= page.total}
                  onClick={() => setPageOffset(n => n + 50)}
                >
                  Next tracks
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
      <section className='prepare-step'>
        <span className='eyebrow'>STEP 3</span>
        <h3>Save your genre playlists</h3>
        <p>
          A new dated DJ Library Organizer folder contains rekordbox XML, one M3U8 playlist per
          category, and import instructions. Import the prepared playlists in rekordbox to start
          browsing by genre.
        </p>
        <p className='muted'>
          Each export is a separate batch. Repeat imports are not automatic synchronization;
          existing collection entries and playlists are not removed. Live import behavior still
          needs verification on your rekordbox installation. M3U8 carries membership only.
        </p>
        <button
          className='button accent'
          id='preparation-export'
          disabled={busy || cleaning || hashing || !plan?.eligible || plan.needsApproval > 0}
          onClick={() =>
            void run(async () => {
              const record = await api.preparationExport(plan!.token)
              if (record) {
                setPlan(null)
                setNotice(
                  `Saved ${record.tracks} tracks across genre playlists. Open the export folder and follow READ ME.txt.`
                )
                await load()
              }
            })
          }
        >
          Save approved playlists…
        </button>
      </section>
      {history.length ? (
        <section className='prepare-step'>
          <h3>Recent exports</h3>
          {history.map(record => (
            <div className='export-record' key={record.id}>
              <strong>{record.namespace}</strong>
              <p>
                {record.tracks} tracks · {record.status} ·{' '}
                {record.reportedImportedAt ? 'You reported imported' : 'Import not reported'}
              </p>
              {record.error ? <p role='alert'>{record.error}</p> : null}
              <code>{record.directory}</code>
              <ExportVerification report={record.verification} />
              <div className='prepare-actions'>
                <button
                  className='button secondary'
                  disabled={busy || cleaning}
                  onClick={() => void run(() => api.preparationReveal(record.id))}
                >
                  Show export folder
                </button>
                {record.status === 'exported' ? (
                  <>
                    <button
                      className='button secondary'
                      disabled={busy || hashing || cleaning}
                      onClick={onRefreshXML}
                    >
                      Refresh Rekordbox XML
                    </button>
                    <button
                      className='button secondary'
                      data-verify-export={record.id}
                      disabled={busy || hashing || cleaning}
                      onClick={() =>
                        void run(async () => {
                          await api.preparationVerify(record.id)
                          await load()
                        })
                      }
                    >
                      Check against refreshed XML
                    </button>
                  </>
                ) : null}
                {record.status === 'exported' && !record.reportedImportedAt ? (
                  <button
                    className='button secondary'
                    disabled={busy || cleaning}
                    onClick={() =>
                      void run(async () => {
                        await api.preparationImported(record.id)
                        await load()
                      })
                    }
                  >
                    I imported this batch
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  )
}

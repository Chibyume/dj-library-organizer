import { useCallback, useEffect, useState } from 'react'
import type { Source } from '../shared'
import type { AutomationOptions, AutomationState } from '../automation-types'
const api = window.organizer
const draft = (v: AutomationOptions): AutomationOptions => ({
  enabled: v.enabled,
  sourceIds: v.sourceIds,
  autoApprove: v.autoApprove,
  syncEnabled: v.syncEnabled,
  watchRekordbox: v.watchRekordbox,
})
export function AutomationSettings({ sources }: { sources: Source[] }) {
  const [state, setState] = useState<AutomationState | null>(null)
  const [options, setOptions] = useState<AutomationOptions | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    const next = await api.automationState()
    setState(next)
    setOptions(previous => previous || draft(next.config))
  }, [])
  useEffect(() => {
    void refresh().catch(e => setError(String(e)))
    return api.onChange(e => {
      if (e.kind === 'automation') void refresh().catch(e => setError(String(e)))
    })
  }, [refresh])
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  if (!state || !options) return <p>Loading automatic handling…</p>
  const disabled = busy || state.active || state.running
  return (
    <section className='automation-settings'>
      <div className='eyebrow'>LESS LIBRARY WORK</div>
      <h2>Automatic downloads & sync</h2>
      <p>
        While this app is open: check every 30 seconds, wait for downloads to settle, classify
        locally, choose preferred copies, and update your ready playlists and complete practice
        library.
      </p>
      <div className='research-status' role='status'>
        <strong>{state.phase}</strong>
        <p>
          {state.pending} waiting to settle · Last completed:{' '}
          {state.lastCompletedAt ? new Date(state.lastCompletedAt).toLocaleString() : 'Not yet'}
        </p>
        {state.sync ? (
          <>
            {state.sync.practiceTracks !== undefined ? (
              <p>
                {state.sync.practiceTracks} practice tracks · {state.sync.practicePlaylists}{' '}
                practice playlists
                {state.sync.practiceOmitted
                  ? ` · ${state.sync.practiceOmitted} unavailable or changed entries skipped`
                  : ''}
              </p>
            ) : null}
            <p>
              {state.sync.tracks} tracks prepared · {state.sync.held} held for review ·{' '}
              {state.sync.awaitingApproval} awaiting approval
            </p>
            {state.sync.preparedIssue ? (
              <p className='field-help'>
                Practice tracks remain available. Prepared playlists need attention:{' '}
                {state.sync.preparedIssue}
              </p>
            ) : null}
            <p>
              XML updated {new Date(state.sync.updatedAt).toLocaleString()}. Refresh/import it in
              Rekordbox.
            </p>
          </>
        ) : null}
        {state.error ? <p className='error-banner'>{state.error}</p> : null}
      </div>
      <h3>Watch these source folders</h3>
      <p className='field-help'>
        Existing files and saved choices are retained. Paused sources are skipped. New subfolders
        are included; partial downloads and app bundles are skipped.
      </p>
      {sources
        .filter(s => !s.broad)
        .map(s => (
          <label className='automation-option' key={s.id}>
            <input
              type='checkbox'
              role='switch'
              className='toggle-switch'
              disabled={disabled}
              checked={options.sourceIds.includes(s.id)}
              onChange={e =>
                setOptions({
                  ...options,
                  sourceIds: e.target.checked
                    ? [...options.sourceIds, s.id]
                    : options.sourceIds.filter(id => id !== s.id),
                })
              }
            />
            <span>
              {s.label}
              {!s.enabled ? ' (source paused)' : ''}
              <small>{s.path}</small>
            </span>
          </label>
        ))}
      <label className='automation-option'>
        <input
          type='checkbox'
          role='switch'
          className='toggle-switch'
          disabled={disabled}
          checked={options.autoApprove}
          onChange={e => setOptions({ ...options, autoApprove: e.target.checked })}
        />
        <span>
          Automatically approve ready classifications for playlists
          <small>
            Uncertain research, conflicting evidence and unverified years still need your review.
            Duplicate files are selected, never automatically trashed.
          </small>
        </span>
      </label>
      <label className='automation-option'>
        <input
          type='checkbox'
          role='switch'
          className='toggle-switch'
          disabled={disabled}
          checked={options.syncEnabled}
          onChange={e => setOptions({ ...options, syncEnabled: e.target.checked })}
        />
        <span>Keep my Rekordbox XML playlists updated</span>
      </label>
      <p className='field-help'>
        {state.config.syncDirectory || 'Choose a folder for the generated playlist library.'}
      </p>
      <div className='settings-buttons'>
        <button disabled={disabled} onClick={() => void run(() => api.automationFolder())}>
          Choose sync folder
        </button>
        <button
          disabled={!state.config.syncDirectory}
          onClick={() => void run(() => api.automationReveal())}
        >
          Show sync folder
        </button>
      </div>
      <label className='automation-option'>
        <input
          type='checkbox'
          role='switch'
          className='toggle-switch'
          disabled={disabled}
          checked={options.watchRekordbox}
          onChange={e => setOptions({ ...options, watchRekordbox: e.target.checked })}
        />
        <span>
          Watch my exported Rekordbox XML
          <small>
            Export your collection from Rekordbox to the same path you previously imported here. The
            app will read changed exports automatically.
          </small>
        </span>
      </label>
      {state.config.rekordboxPath ? (
        <p className='field-help'>{state.config.rekordboxPath}</p>
      ) : null}
      <p>
        In Rekordbox, point the XML library at the sync folder’s rekordbox.xml once. After updates,
        refresh the rekordbox xml tree and import DJ Library Organizer → Practice Library for all
        available songs, current genres and your personal playlists. Prepared playlists remain a
        separate approved subset. Check Rekordbox’s replacement prompts; existing playlist
        memberships may remain. The app does not replace existing playlists or change the live
        Collection automatically.
      </p>
      {error ? (
        <p className='error-banner' role='alert'>
          {error}
        </p>
      ) : null}
      <div className='settings-buttons'>
        {state.active || state.running ? (
          <button
            className='button secondary'
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const next = await api.automationConfigure({
                  ...draft(state.config),
                  enabled: false,
                })
                setOptions(draft(next.config))
              })
            }
          >
            Pause automatic handling
          </button>
        ) : (
          <button
            className='button primary'
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const next = await api.automationConfigure({
                  ...options,
                  enabled: true,
                })
                setOptions(draft(next.config))
              })
            }
          >
            Save & start automatic handling
          </button>
        )}
        <button
          disabled={busy || !state.active || state.running}
          onClick={() => void run(() => api.automationCheck())}
        >
          Check now
        </button>
      </div>
    </section>
  )
}

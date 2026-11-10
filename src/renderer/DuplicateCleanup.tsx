import { useEffect, useRef, useState } from 'react'
import type { CleanupPreview, CleanupState } from '../preparation-types'
const api = window.organizer
const size = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`
export function DuplicateCleanup({
  disabled,
  onDone,
  onRunning,
}: {
  disabled: boolean
  onDone: () => void
  onRunning: (running: boolean) => void
}) {
  const [includeReferenced, setIncludeReferenced] = useState(false)
  const [plan, setPlan] = useState<CleanupPreview | null>(null)
  const [history, setHistory] = useState<Awaited<ReturnType<typeof api.cleanupHistory>>>([])
  const historyKey = useRef<string | null>(null)
  const [state, setState] = useState<CleanupState | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const callbacks = useRef({ onDone, onRunning })
  callbacks.current = { onDone, onRunning }
  const last = useRef(false)
  useEffect(() => {
    let alive = true,
      pending = false
    async function refresh() {
      if (pending) return
      pending = true
      try {
        const s = await api.cleanupState()
        if (!alive) return
        setState(s)
        const key = s ? s.id + s.status + s.restored : 'empty'
        if (historyKey.current !== key) {
          const batches = await api.cleanupHistory()
          if (!alive) return
          setHistory(batches)
          historyKey.current = key
        }
        const running = s?.status === 'running' || s?.status === 'restoring'
        callbacks.current.onRunning(running)
        if (last.current && !running) callbacks.current.onDone()
        last.current = running
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not read cleanup progress.')
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cleanup failed.')
    } finally {
      setBusy(false)
    }
  }
  const running = state?.status === 'running' || state?.status === 'restoring'
  return (
    <section className='prepare-step'>
      <h3>Remove the extra files</h3>
      <p>
        Move verified identical extras to macOS Trash in one batch. You can include copies
        referenced by Rekordbox or saved exports. Different encodings and uncertain versions are
        retained.
      </p>
      <label>
        <input
          type='checkbox'
          checked={includeReferenced}
          disabled={disabled || busy || running}
          onChange={e => {
            setIncludeReferenced(e.target.checked)
            setPlan(null)
          }}
        />{' '}
        Include extras referenced by Rekordbox or saved exports
      </label>
      <p>
        Existing Rekordbox entries pointing to removed copies will show missing files. The chosen
        copy stays in place.
      </p>
      <button
        className='button secondary'
        disabled={disabled || busy || running}
        onClick={() =>
          void run(async () => setPlan(await api.cleanupPreview({ includeReferenced })))
        }
      >
        Preview duplicate cleanup
      </button>
      {error ? (
        <p className='message error' role='alert'>
          {error}
        </p>
      ) : null}
      {plan ? (
        <div className='research-job'>
          <strong>
            {plan.files} extra files · {size(plan.bytes)} · recoverable in Trash
          </strong>
          <p>
            {Object.entries(plan.protected)
              .map(([reason, n]) => `${n}: ${reason}`)
              .join(' · ') ||
              'Every selected extra has a keeper and a matching complete-file hash.'}
          </p>
          {plan.includeReferenced ? (
            <p>
              {plan.referencedExtras} referenced extras are included in this batch. Existing
              playlists are not redirected automatically.
            </p>
          ) : null}
          <details>
            <summary>Show examples of files to remove</summary>
            {plan.examples.map(e => (
              <p key={e.path}>
                <strong>{e.title}</strong>
                <br />
                Remove: {e.path}
                <br />
                Keep: {e.keeper}
              </p>
            ))}
          </details>
          <p>
            Reference counts come from imported snapshots, not a live Rekordbox connection. Keep
            Trash until you have checked your library. This never empties Trash.
          </p>
          <button
            className='button primary'
            disabled={disabled || busy || running || !plan.files}
            onClick={() =>
              void run(async () => {
                await api.cleanupStart(plan.token)
                setPlan(null)
                const s = await api.cleanupState()
                setState(s)
                last.current = true
                callbacks.current.onRunning(true)
              })
            }
          >
            Move {plan.files} extras to Trash
          </button>
        </div>
      ) : null}
      {state ? (
        <div className='research-job' role='status'>
          <strong>Cleanup {state.status}</strong>
          <p>
            {state.trashed} moved to Trash · {state.restored} restored · {state.failed} checks need
            attention · {size(state.bytes)} moved
          </p>
          {state.current ? <p>{state.current}</p> : null}
          {state.error ? <p>{state.error}</p> : null}
          {running ? (
            <button
              className='button secondary'
              onClick={() => void run(async () => api.cleanupPause())}
            >
              Pause cleanup
            </button>
          ) : null}
          {!running && state.trashed > state.restored ? (
            <button
              className='button secondary'
              disabled={disabled || busy}
              onClick={() =>
                void run(async () => {
                  await api.cleanupRestore(state.id)
                  setState(await api.cleanupState())
                  last.current = true
                  callbacks.current.onRunning(true)
                })
              }
            >
              Restore this batch from Trash
            </button>
          ) : null}
        </div>
      ) : null}
      {history.some(h => h.id !== state?.id && h.trashed > h.restored) ? (
        <details>
          <summary>Earlier cleanup batches</summary>
          {history
            .filter(h => h.id !== state?.id && h.trashed > h.restored)
            .map(h => (
              <p key={h.id}>
                {new Date(h.createdAt).toLocaleString()} · {h.trashed - h.restored} files in Trash{' '}
                <button
                  className='button secondary'
                  disabled={disabled || busy || running}
                  onClick={() =>
                    void run(async () => {
                      await api.cleanupRestore(h.id)
                      setState(await api.cleanupState())
                      last.current = true
                      callbacks.current.onRunning(true)
                    })
                  }
                >
                  Restore earlier batch
                </button>
              </p>
            ))}
        </details>
      ) : null}
    </section>
  )
}

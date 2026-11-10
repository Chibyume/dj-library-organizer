import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { Track } from '../shared'
import type { TrashRestoreResult } from '../track-trash-types'

type Run = (fn: () => Promise<unknown>) => Promise<boolean>

export function TrashSelectionActions({
  tracks,
  busy,
  run,
  onResult,
}: {
  tracks: Track[]
  busy: boolean
  run: Run
  onResult?: (result: TrashRestoreResult) => void
}) {
  const [result, setResult] = useState<TrashRestoreResult | null>(null)
  const [names, setNames] = useState<Record<string, string>>({})
  const physical = tracks.some(track => track.trash?.state === 'in-trash')
  return (
    <>
      <button
        id='trash-restore-selected'
        className='button secondary compact'
        disabled={busy || !tracks.length}
        onClick={() => {
          const changes = tracks.map(({ id, revision }) => ({ id, revision }))
          setResult(null)
          setNames(
            Object.fromEntries(tracks.map(track => [track.id, track.title || track.filename]))
          )
          void run(async () => {
            const next = await window.organizer.trashRestoreFiles(changes)
            setResult(next)
            onResult?.(next)
          })
        }}
      >
        <RotateCcw size={14} /> Restore selected
      </button>
      <span className='field-help'>
        {physical
          ? 'Restore recorded Trash files to their original paths. Existing files are never overwritten.'
          : 'Return these entries to the library. Originals left in place are not moved.'}
      </span>
      {result ? (
        <div className='trash-restore-result' role={result.failed ? 'alert' : 'status'}>
          <span>
            {result.restored} restored · {result.failed} need attention
          </span>
          {result.errors.map(error => (
            <p className='track-error' key={error.id}>
              {names[error.id] || 'Selected track'}: {error.message}
            </p>
          ))}
        </div>
      ) : null}
    </>
  )
}

export function TrashDetails({ track }: { track: Track }) {
  const info = track.trash
  const state = info?.state || 'unconfirmed'
  const label =
    state === 'in-trash'
      ? 'Moved to macOS Trash'
      : state === 'original-kept'
        ? 'Removed from library · original kept'
        : 'Removed from library · location unconfirmed'
  const removedAt = info?.removedAt ? Date.parse(info.removedAt) : NaN
  return (
    <section className='panel-section trash-details' data-trash-state={state}>
      <div className='field-label'>TRASH & RECOVERY</div>
      <h3>{label}</h3>
      <p className='field-help'>
        {state === 'in-trash'
          ? 'This entry is recorded as moved to macOS Trash. Restore checks saved recovery evidence and the file, and never overwrites an occupied original path. Missing recovery evidence may require Finder recovery.'
          : state === 'original-kept'
            ? 'The app removed this entry without moving its audio file. Restore selected returns the entry to the library.'
            : 'The physical location could not be confirmed. Restore selected returns the catalog entry using its saved availability; it may still appear unavailable.'}
      </p>
      <dl className='file-details'>
        <dt>Removed</dt>
        <dd>{Number.isFinite(removedAt) ? new Date(removedAt).toLocaleString() : '—'}</dd>
        <dt>Operation</dt>
        <dd>
          {info?.origin === 'duplicate'
            ? 'Duplicate cleanup'
            : info?.origin === 'selected'
              ? 'Selected songs'
              : 'Catalog removal'}
        </dd>
      </dl>
      <div className='path-label'>ORIGINAL PATH</div>
      <p className='file-path'>{info?.originalPath || track.path}</p>
      {info?.trashPath ? (
        <>
          <div className='path-label'>RECORDED TRASH PATH</div>
          <p className='file-path'>{info.trashPath}</p>
        </>
      ) : null}
      {info?.reason ? <p className='field-help trash-reason'>{info.reason}</p> : null}
    </section>
  )
}

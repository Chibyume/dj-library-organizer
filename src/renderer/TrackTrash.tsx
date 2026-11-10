import { useEffect, useRef, useState } from 'react'
import type { TrackTrashChange, TrackTrashPreview, TrackTrashResult } from '../track-trash-types'

const api = window.organizer
const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`

export function TrackTrashDialog({
  changes,
  scope = 'selected',
  onClose,
  onChanged,
  onBusy,
  onBrowse,
}: {
  changes: TrackTrashChange[]
  scope?: 'selected' | 'junk'
  onClose: () => void
  onChanged: () => void
  onBusy?: (busy: boolean) => void
  onBrowse?: () => void
}) {
  const [preview, setPreview] = useState<TrackTrashPreview | null>(null)
  const [result, setResult] = useState<TrackTrashResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [previewOffset, setPreviewOffset] = useState(0)
  useEffect(() => {
    onBusy?.(busy)
    return () => onBusy?.(false)
  }, [busy, onBusy])
  const [operation, setOperation] = useState<'preview' | 'trash' | 'restore'>('preview')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const request = useRef(0)
  const selectionKey =
    scope === 'junk' ? 'junk' : changes.map(({ id, revision }) => `${id}:${revision}`).join('|')
  useEffect(() => {
    mounted.current = true
    const current = ++request.current
    setPreview(null)
    setPreviewOffset(0)
    setResult(null)
    setError('')
    setBusy(true)
    setOperation('preview')
    void (async () => {
      const next =
        scope === 'junk'
          ? await api.trackTrashPreviewJunk()
          : changes.length
            ? await api.trackTrashPreview(changes)
            : null
      if (mounted.current && current === request.current) {
        setPreview(next)
      }
    })()
      .catch(failure => {
        if (mounted.current && current === request.current)
          setError(failure instanceof Error ? failure.message : 'Could not preview these files.')
      })
      .finally(() => {
        if (mounted.current && current === request.current) setBusy(false)
      })
    return () => {
      mounted.current = false
    }
  }, [selectionKey, scope])

  async function run(
    action: () => Promise<TrackTrashResult>,
    nextOperation: 'trash' | 'restore' = 'trash'
  ) {
    setBusy(true)
    setOperation(nextOperation)
    setError('')
    try {
      const next = await action()
      onChanged()
      if (!mounted.current) return
      setResult(next)
      setPreview(null)
    } catch (failure) {
      if (mounted.current) {
        setError(
          failure instanceof Error ? failure.message : 'The file operation could not be confirmed.'
        )
        setPreview(null)
      }
      onChanged()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  return (
    <section className='prepare-workflow'>
      <div className='eyebrow'>RECOVERABLE FILE REMOVAL</div>
      <h2>
        {scope === 'junk'
          ? 'Remove all Junk'
          : changes.length
            ? 'Move selected songs to Trash'
            : 'Trash & restore'}
      </h2>
      {scope === 'junk' ? (
        <p id='track-trash-scope-note'>
          This includes every song assigned to Junk across your whole library, regardless of the
          current search, page or selection. Nothing changes until you confirm the complete preview
          below.
        </p>
      ) : null}
      <p className='muted'>
        Files that can be moved go to macOS Trash. If one cannot be moved, its entry is removed from
        the visible library. Blocked originals remain in place and uncertain outcomes are reported
        below. The batch continues with the other files. Only confirmed physical moves appear in
        Trash. Nothing is permanently deleted.
      </p>
      {error ? (
        <p className='message error' role='alert'>
          {error}
        </p>
      ) : null}
      {busy ? (
        <p className='field-help' role='status'>
          {operation === 'preview'
            ? scope === 'junk'
              ? 'Checking all Junk files and known references…'
              : 'Checking selected files and known references…'
            : operation === 'restore'
              ? 'Restoring files… Keep the app open until this finishes.'
              : 'Verifying and moving files… Keep the app open until this finishes.'}
        </p>
      ) : null}
      {preview ? (
        <div className='prepare-step'>
          <h3>
            {preview.files.length} {preview.files.length === 1 ? 'file' : 'files'} ·{' '}
            {size(preview.bytes)}
          </h3>
          {preview.catalogOnly ? (
            <p className='field-help'>
              {preview.catalogOnly} cannot be moved safely and will only be removed from the
              library. No physical move will be attempted for these entries.
            </p>
          ) : null}
          <p>
            {preview.rekordboxReferences} imported Rekordbox track references ·{' '}
            {preview.exportReferences} saved export references. Playlists using physically moved
            paths will show missing files. Library-only removal keeps those paths unchanged.
            References are not redirected to other copies.
          </p>
          <p className='field-help'>
            {preview.snapshotImportedAt
              ? `Rekordbox snapshot imported ${new Date(preview.snapshotImportedAt).toLocaleString()}. `
              : 'No active Rekordbox snapshot is available. '}
            These counts are saved evidence, not a live Rekordbox connection.
          </p>
          <details open={preview.files.length <= 5}>
            <summary>
              Review every {scope === 'junk' ? 'Junk' : 'selected'} file ({preview.files.length})
            </summary>
            <div style={{ maxHeight: 320, overflowY: 'auto', marginTop: 12 }}>
              {preview.files.slice(previewOffset, previewOffset + 100).map(file => (
                <div className='panel-section' key={file.id}>
                  <strong>{file.title}</strong>
                  {file.artist ? <span className='muted'> · {file.artist}</span> : null}
                  <p className='field-help' style={{ overflowWrap: 'anywhere' }}>
                    {file.path}
                  </p>
                  {file.action === 'remove-from-library' ? (
                    <p className='field-help'>
                      Remove from library only · {file.reason || 'Original file stays in place.'}
                    </p>
                  ) : null}
                  <p className='field-help'>
                    {size(file.size)} · {file.rekordboxReferences} Rekordbox references ·{' '}
                    {file.exportReferences} saved exports
                  </p>
                </div>
              ))}
            </div>
            {preview.files.length > 100 ? (
              <div className='prepare-actions'>
                <button
                  className='button secondary'
                  disabled={busy || previewOffset === 0}
                  onClick={() => setPreviewOffset(offset => Math.max(0, offset - 100))}
                >
                  Previous files
                </button>
                <span>
                  {previewOffset + 1}–{Math.min(previewOffset + 100, preview.files.length)} of{' '}
                  {preview.files.length}
                </span>
                <button
                  className='button secondary'
                  disabled={busy || previewOffset + 100 >= preview.files.length}
                  onClick={() => setPreviewOffset(offset => offset + 100)}
                >
                  Next files
                </button>
              </div>
            ) : null}
          </details>
          <p>
            Only this final action moves files or removes their library entries. If one file fails,
            the remaining files are still processed.
          </p>
          <div
            className='action-row'
            style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}
          >
            <button className='button secondary' disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              className='button danger'
              disabled={busy || preview.files.length === 0}
              onClick={() => void run(() => api.trackTrashStart(preview.token))}
            >
              {scope === 'junk'
                ? `Remove all ${preview.files.length} songs in Junk`
                : preview.catalogOnly === preview.files.length
                  ? `Remove ${preview.files.length} ${preview.files.length === 1 ? 'file' : 'files'} from library`
                  : preview.catalogOnly
                    ? `Process ${preview.files.length} selected files`
                    : `Move ${preview.files.length} ${preview.files.length === 1 ? 'file' : 'files'} to Trash`}
            </button>
          </div>
        </div>
      ) : null}
      {result ? (
        <div className='prepare-step' role='status'>
          <h3>
            {result.status === 'restored'
              ? 'Files restored'
              : result.status === 'completed'
                ? result.removed
                  ? 'Selected songs removed'
                  : 'Files moved to Trash'
                : 'Some files need attention'}
          </h3>
          <p>
            {result.moved} moved to Trash · {result.removed ?? 0} removed from library ·{' '}
            {result.restored} restored · {result.failed} need attention · {result.uncertain}{' '}
            uncertain
          </p>
          {result.error ? <p className='message error'>{result.error}</p> : null}
          {result.files.some(file => file.error) ? (
            <details open>
              <summary>Files needing attention</summary>
              {result.files
                .filter(file => file.error)
                .map(file => (
                  <p key={file.id} style={{ overflowWrap: 'anywhere' }}>
                    <strong>{file.title}</strong>
                    <br />
                    {file.path}
                    <br />
                    {file.error}
                    {file.status === 'removed' ? (
                      <>
                        <br />
                        {file.locationState === 'original-kept'
                          ? 'Removed from library. Original file kept in place.'
                          : 'Removed from library. File location unconfirmed.'}
                      </>
                    ) : null}
                    {file.trashPath ? (
                      <>
                        <br />
                        Recorded Trash path: {file.trashPath}
                      </>
                    ) : null}
                  </p>
                ))}
            </details>
          ) : null}
          {result.files.some(file => file.status === 'trashed' || file.status === 'removed') ? (
            <button
              className='button secondary'
              disabled={busy}
              onClick={() => void run(() => api.trackTrashRestore(result.id), 'restore')}
            >
              Restore this batch
            </button>
          ) : null}
        </div>
      ) : null}
      {onBrowse ? (
        <>
          <p className='field-help'>
            Trash shows files confirmed moved to macOS Trash. Files kept in their original locations
            stay out of the visible library.
          </p>
          <button
            className='text-button'
            id='view-trash-library'
            disabled={busy}
            onClick={onBrowse}
          >
            View Trash library
          </button>
        </>
      ) : null}
      {!preview ? (
        <button className='button secondary' disabled={busy} onClick={onClose}>
          Done
        </button>
      ) : null}
    </section>
  )
}

import { useEffect, useState } from 'react'
import type { Track, XMLTrackEvidence } from '../shared'
export function TrackEvidence({
  track,
  onConnect,
  generation,
}: {
  track: Track
  onConnect: () => void
  generation: number
}) {
  const [evidence, setEvidence] = useState<XMLTrackEvidence | null>(null),
    [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setEvidence(null)
    setError('')
    void window.organizer
      .xmlTrack(track.id)
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
  return (
    <>
      <div className='panel-section'>
        <div className='field-label'>FILE CAPABILITIES</div>
        <dl className='file-details'>
          <dt>Inventoried</dt>
          <dd>Yes · {track.availability}</dd>
          <dt>Preview</dt>
          <dd>
            {evidence?.preview === 'played'
              ? 'Played locally'
              : evidence?.preview === 'failed'
                ? 'Failed locally'
                : 'Not tested'}
          </dd>
          <dt>Metadata</dt>
          <dd>
            {track.metadataError
              ? 'Partial / failed read'
              : track.format
                ? 'Read locally'
                : 'Not available'}
          </dd>
          <dt>BPM / key analysis</dt>
          <dd>Not implemented</dd>
          <dt>rekordbox import</dt>
          <dd>Untested for this file</dd>
        </dl>
        {evidence?.previewError ? <p className='track-error'>{evidence.previewError}</p> : null}
        <p className='field-help'>
          Tags are read during scanning and classified locally. Audio BPM/key analysis is not
          implemented.
        </p>
      </div>
      <div className='panel-section'>
        <div className='field-label'>REKORDBOX SNAPSHOT</div>
        {error ? (
          <p className='track-error'>{error}</p>
        ) : !evidence ? (
          <p className='field-help'>Checking snapshot evidence…</p>
        ) : !evidence.snapshot ? (
          <p className='field-help'>
            Unknown · connect a current XML export to compare references.
          </p>
        ) : (
          <>
            <p className='field-help'>
              Snapshot imported {new Date(evidence.snapshot.importedAt).toLocaleString()}
            </p>
            {evidence.entries.length ? (
              evidence.entries.map(e => (
                <div className='track-xml-evidence' key={e.trackKey}>
                  <strong>
                    {e.status === 'referenced'
                      ? 'Referenced in snapshot'
                      : 'Identity requires review'}
                  </strong>
                  <p className='field-help'>{e.reason}</p>
                  <p className='field-help'>
                    TrackID {e.trackKey} · {e.playlists.length} playlists · {e.cueCount} cue/loop
                    markers · {e.tempoCount} grid markers
                  </p>
                  {e.conflicts.slice(0, 6).map((c, i) => (
                    <p className='track-error' key={i}>
                      {c}
                    </p>
                  ))}
                </div>
              ))
            ) : (
              <p className='field-help'>
                No matched reference in this snapshot. Live rekordbox status remains unknown.
              </p>
            )}
          </>
        )}
        <button className='text-button' onClick={onConnect}>
          Refresh Rekordbox Library
        </button>
      </div>
    </>
  )
}

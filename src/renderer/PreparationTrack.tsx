import { useEffect, useState } from 'react'
import type { ClassificationEvidence } from '../shared'
import type { PreparationItem } from '../preparation-types'

export function PreparationTrack({
  item,
  busy,
  onReview,
}: {
  item: PreparationItem
  busy: boolean
  onReview: (reason?: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [evidence, setEvidence] = useState<ClassificationEvidence | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!expanded) return
    let stale = false
    void window.organizer
      .classificationTrack(item.id)
      .then(value => {
        if (!stale) setEvidence(value)
      })
      .catch(e => {
        if (!stale) setError(e.message)
      })
    return () => {
      stale = true
    }
  }, [item.id, expanded])
  return (
    <div className='prepare-track' data-preparation-track={item.id}>
      <div className='prepare-track-info'>
        <strong>{item.title}</strong>
        <span className='muted'>{item.artist || 'Missing artist'}</span>
        <small>
          {item.reason || (item.approved ? 'Approved' : 'Ready to approve')} · Playlist:{' '}
          {item.category || 'Unclassified'}
        </small>
        {item.category !== item.catalogCategory ? (
          <small className='muted'>Saved category: {item.catalogCategory || 'Unclassified'}</small>
        ) : null}
        <details onToggle={event => setExpanded(event.currentTarget.open)}>
          <summary>Details & evidence{item.notes.length ? ' · export notes' : ''}</summary>
          <code>{item.path}</code>
          {item.notes.map(note => (
            <p className='field-help' key={note}>
              {note}
            </p>
          ))}
          {error ? <p role='alert'>{error}</p> : null}
          {evidence?.reasons.map(reason => (
            <p className='field-help' key={reason}>
              {reason}
            </p>
          ))}
          {evidence?.evidence.map((source, index) => (
            <p className='field-help' key={index}>
              <strong>{source.source}:</strong> {source.value}
            </p>
          ))}
        </details>
      </div>
      {item.reason ? (
        <button className='button secondary' disabled={busy} onClick={() => onReview(item.reason!)}>
          Open in Review
        </button>
      ) : null}
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, RefreshCw, FolderOpen, FileText, CheckCircle2, CircleAlert } from 'lucide-react'
import type { XMLCandidates, XMLPage, XMLProgress, XMLQuery, XMLSummary } from '../shared'
const api = window.organizer
const date = (s: string) => new Date(s).toLocaleString()
const FILTERS: { value: XMLQuery['status']; label: string }[] = [
  { value: 'all', label: 'All references' },
  { value: 'referenced', label: 'Referenced paths' },
  { value: 'conflict', label: 'Metadata differences' },
  { value: 'possible', label: 'Needs identity review' },
  { value: 'ambiguous', label: 'Ambiguous' },
  { value: 'unmatched', label: 'Not discovered' },
  { value: 'nonlocal', label: 'Nonlocal' },
  { value: 'invalid', label: 'Invalid URL' },
]
export function RekordboxConnection({ onClose }: { onClose: () => void }) {
  const [summary, setSummary] = useState<XMLSummary | null>(null)
  const [candidates, setCandidates] = useState<XMLCandidates>({
    candidates: [],
    warnings: [],
  })
  const [selected, setSelected] = useState('')
  const [progress, setProgress] = useState<XMLProgress | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<XMLQuery['status']>('all'),
    [node, setNode] = useState('')
  const [page, setPage] = useState(0),
    [entries, setEntries] = useState<XMLPage>({ entries: [], total: 0 })
  const [generation, setGeneration] = useState(0),
    [loading, setLoading] = useState(false)
  const mounted = useRef(true)
  const load = useCallback(async () => {
    const s = await api.xmlSummary()
    if (mounted.current) setSummary(s)
  }, [])
  useEffect(() => {
    mounted.current = true
    void load().catch(e => setError(e.message))
    const off = api.onChange(e => {
      if (e.xmlProgress) {
        setProgress(e.xmlProgress)
        if (e.xmlProgress.phase === 'completed') {
          void load().catch(e => setError(e.message))
          setGeneration(n => n + 1)
        }
      }
    })
    return () => {
      mounted.current = false
      off()
    }
  }, [load])
  useEffect(() => {
    let alive = true
    setLoading(true)
    void api
      .xmlList({
        status: filter,
        ...(node ? { nodeId: node } : {}),
        offset: page * 50,
        limit: 50,
      })
      .then(p => {
        if (alive) setEntries(p)
      })
      .catch(e => {
        if (alive) setError(e.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [filter, node, page, generation, summary?.id])
  async function run(fn: () => Promise<XMLCandidates | XMLSummary>, importing = false) {
    setBusy(true)
    setError(null)
    try {
      const result = await fn()
      if (!mounted.current) return
      if (importing) {
        setSummary(result as XMLSummary)
        setCandidates({ candidates: [], warnings: [] })
        setSelected('')
        setNode('')
        setFilter('all')
        setPage(0)
        setGeneration(n => n + 1)
      } else {
        const c = result as XMLCandidates
        if (c.candidates.length || c.warnings.length) {
          setCandidates(c)
          setSelected('')
        }
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : 'XML operation failed.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <div className='xml-connection'>
      <div className='eyebrow'>LOCAL XML SNAPSHOT</div>
      <h2>Connect Your Rekordbox Library</h2>
      <p>
        Export your current collection to connect the files and playlists rekordbox already knows.
      </p>
      <ol className='xml-instructions'>
        <li>Open rekordbox 7.</li>
        <li>
          Choose <strong>File → Export Collection in xml format</strong>.
        </li>
        <li>Save the export somewhere convenient, such as Downloads.</li>
        <li>Return here, drop the XML or its folder, then select the snapshot to import.</li>
      </ol>
      <div
        className={`future-drop xml-drop${busy ? ' is-busy' : ''}`}
        onDragOver={e => {
          e.preventDefault()
          e.dataTransfer.dropEffect = busy ? 'none' : 'copy'
        }}
        onDrop={e => {
          e.preventDefault()
          if (!busy) void run(() => api.xmlDrop(Array.from(e.dataTransfer.files)))
        }}
      >
        <Download size={26} />
        <strong>Drop your rekordbox XML here</strong>
        <span>or drop a folder containing it</span>
        <div className='xml-actions'>
          <button
            className='button secondary'
            disabled={busy}
            onClick={() => void run(() => api.xmlChoose('file'))}
          >
            <FileText size={15} />
            Choose File
          </button>
          <button
            className='button secondary'
            disabled={busy}
            onClick={() => void run(() => api.xmlChoose('folder'))}
          >
            <FolderOpen size={15} />
            Choose Folder
          </button>
        </div>
      </div>
      {progress && busy ? (
        <div className='xml-progress' role='status'>
          <strong>{progress.message}</strong>
          <span>
            {progress.filename} · {progress.tracks.toLocaleString()} tracks ·{' '}
            {(progress.bytes / 1048576).toFixed(1)} MiB read
          </span>
          <button onClick={() => void api.xmlCancel().catch(e => setError(e.message))}>
            Cancel XML operation
          </button>
        </div>
      ) : null}
      {error ? (
        <p className='track-error' role='alert'>
          {error}
        </p>
      ) : null}
      {candidates.warnings.map((w, i) => (
        <p className='field-help' key={i}>
          {w}
        </p>
      ))}
      {candidates.candidates.length ? (
        <fieldset className='xml-candidates'>
          <legend>Choose the snapshot to import</legend>
          {candidates.candidates.map(c => (
            <label key={c.id} className={`xml-candidate${c.valid ? '' : ' invalid'}`}>
              <input
                type='radio'
                name='xml-candidate'
                value={c.id}
                checked={selected === c.id}
                disabled={busy || !c.valid}
                onChange={() => setSelected(c.id)}
              />
              <div>
                <strong>{c.filename}</strong>
                <p className='file-path'>{c.path}</p>
                <small>
                  Disk modified {date(c.modifiedAt)} · {(c.size / 1048576).toFixed(2)} MiB
                </small>
                <p>
                  {c.valid
                    ? `${c.tracks.toLocaleString()} tracks · ${c.playlists.toLocaleString()} playlists · ${c.product}`
                    : c.error}
                </p>
              </div>
              {c.valid ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}
            </label>
          ))}
          <p className='field-help'>
            Disk modification time is not a verified export date. Importing uses the validated copy
            and keeps the previous snapshot in local history.
          </p>
          <button
            className='button primary'
            data-xml-import
            disabled={busy || !selected}
            onClick={() => void run(() => api.xmlImport(selected), true)}
          >
            Import selected snapshot
          </button>
        </fieldset>
      ) : null}
      {summary ? (
        <section className='xml-snapshot' aria-label='Current rekordbox snapshot'>
          <div className='xml-summary-title'>
            <h3>Current snapshot</h3>
            <button
              className='button secondary'
              data-xml-refresh
              disabled={busy}
              onClick={() => void run(() => api.xmlChoose('refresh'))}
            >
              <RefreshCw size={14} />
              Refresh Rekordbox Library
            </button>
          </div>
          <p className='file-path'>{summary.sourcePath}</p>
          <p className='field-help'>
            Imported {date(summary.importedAt)} · Disk modified {date(summary.modifiedAt)} ·{' '}
            {summary.product}
            <br />
            SHA-256 {summary.hash.slice(0, 16)}… · matched {date(summary.matchedAt)}
          </p>
          <div className='xml-counts'>
            <span>
              <b>{summary.tracks.toLocaleString()}</b>collection references
            </span>
            <span>
              <b>{summary.counts.referenced.toLocaleString()}</b>exact catalog paths
            </span>
            <span>
              <b>{summary.playlists.toLocaleString()}</b>playlists
            </span>
            <span>
              <b>{summary.counts.conflict.toLocaleString()}</b>metadata differences
            </span>
          </div>
          {summary.warnings.map((w, i) => (
            <p className='track-error' key={i}>
              {w}
            </p>
          ))}
          {summary.dangling ? (
            <p className='field-help'>
              {summary.dangling.toLocaleString()} unresolved playlist memberships retained in the
              original snapshot.
            </p>
          ) : null}
          <div className='xml-filters'>
            <label>
              References
              <select
                aria-label='Filter XML references'
                value={filter}
                onChange={e => {
                  setFilter(e.target.value as XMLQuery['status'])
                  setPage(0)
                }}
              >
                {FILTERS.map(f => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Playlist
              <select
                aria-label='Filter XML playlist'
                value={node}
                onChange={e => {
                  setNode(e.target.value)
                  setPage(0)
                }}
              >
                <option value=''>All playlists</option>
                {summary.nodes.map(n => (
                  <option key={n.id} value={n.id} disabled={n.type === 'folder'}>
                    {'　'.repeat(Math.min(n.depth, 8))}
                    {n.type === 'folder' ? '▸ ' : '♪ '}
                    {n.name} ({n.entries})
                  </option>
                ))}
              </select>
            </label>
          </div>
          {summary.nodeCount > summary.nodes.length ? (
            <p className='field-help'>
              The selector shows the first {summary.nodes.length} nodes; all{' '}
              {summary.nodeCount.toLocaleString()} are retained.
            </p>
          ) : null}
          <div className='xml-reference-list' aria-busy={loading}>
            {entries.entries.map(t => (
              <details key={t.trackKey} className='xml-entry'>
                <summary>
                  <span>
                    <strong>
                      {t.attrs.Artist ? `${t.attrs.Artist} — ` : ''}
                      {t.attrs.Name || t.attrs.Location || `Track ${t.trackKey}`}
                    </strong>
                    <small>
                      TrackID {t.trackKey} · {t.cueCount} cue/loop markers · {t.tempoCount} grid
                      markers
                    </small>
                  </span>
                  <span className={`xml-status ${t.status}`}>
                    {t.status}
                    {t.conflicts.length ? ' · differs' : ''}
                  </span>
                </summary>
                <p>{t.reason}</p>
                <p className='file-path'>{t.localPath || t.attrs.Location}</p>
                {t.playlists.length ? (
                  <p className='field-help'>Playlists: {t.playlists.join(' · ')}</p>
                ) : null}
                {t.conflicts.map((c, i) => (
                  <p className='track-error' key={i}>
                    {c}
                  </p>
                ))}
                {t.cueCount ? (
                  <p className='field-help'>
                    Markers:{' '}
                    {t.cues
                      .slice(0, 8)
                      .map(
                        c => `${c.Name || 'Unnamed'} @ ${c.Start || '?'}s (type ${c.Type || '?'})`
                      )
                      .join(' · ')}
                  </p>
                ) : null}
                <p className='field-help'>
                  XML fields and DJ preparation remain snapshot evidence. Existing categories and
                  embedded tags were not replaced.
                </p>
              </details>
            ))}
            {!entries.total ? (
              <p className='field-help'>
                {loading ? 'Loading references…' : 'No references in this view.'}
              </p>
            ) : null}
          </div>
          <div className='xml-pagination'>
            <span>
              {entries.total.toLocaleString()} references · page {page + 1} of{' '}
              {Math.max(1, Math.ceil(entries.total / 50))}
            </span>
            <button disabled={busy || loading || !page} onClick={() => setPage(p => p - 1)}>
              Previous
            </button>
            <button
              disabled={busy || loading || (page + 1) * 50 >= entries.total}
              onClick={() => setPage(p => p + 1)}
            >
              Next
            </button>
          </div>
        </section>
      ) : null}
      <p className='field-help'>
        XML is a local snapshot, not a live connection or a complete backup. An absent reference
        does not establish that a file is safe to move. XML references do not authorize scanning new
        audio locations.
      </p>
      <button className='text-button' onClick={onClose}>
        {summary
          ? 'Return to library'
          : 'Skip for now · use the library with unknown rekordbox status'}
      </button>
    </div>
  )
}

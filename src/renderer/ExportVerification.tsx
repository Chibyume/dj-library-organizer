import type { ExportVerification as Report } from '../preparation-types'
export function ExportVerification({ report }: { report: Report | undefined }) {
  if (!report)
    return (
      <p className='muted'>
        No XML comparison yet. After importing the dated batch folder into rekordbox, export a fresh
        XML and refresh it here.
      </p>
    )
  return (
    <div
      className='export-verification'
      data-verification={report.current ? report.status : 'stale'}
    >
      <strong>
        {!report.current
          ? 'Snapshot changed — check again'
          : report.status === 'matched'
            ? 'Playlist paths match this XML'
            : report.status === 'differences'
              ? 'Playlist differences found'
              : 'A fresh rekordbox snapshot is needed'}
      </strong>
      <p>{report.message}</p>
      {report.snapshot ? (
        <p className='muted'>
          {report.snapshot.product} · Snapshot imported{' '}
          {new Date(report.snapshot.importedAt).toLocaleString()} · Checked{' '}
          {new Date(report.checkedAt).toLocaleString()}
          <code>{report.snapshot.sourcePath}</code>
          File modified {new Date(report.snapshot.modifiedAt).toLocaleString()}; this is not a
          verified export time.
        </p>
      ) : null}
      {report.playlists.length ? (
        <>
          <p>
            {report.matched} of {report.expected} exported paths matched in their expected genre
            playlists
            {!report.current ? ' in the previous snapshot' : ''}.
          </p>
          <details>
            <summary>Per-playlist results ({report.playlists.length})</summary>
            {report.playlists.map(p => (
              <div className='verification-playlist' key={p.category}>
                <strong>
                  {p.group} / {p.category}
                </strong>
                <p>
                  {p.matched}/{p.expected} matched · {p.missing} missing · {p.ambiguous} ambiguous ·{' '}
                  {p.extra} extra · {p.unresolved} unresolved references · {p.duplicateEntries}{' '}
                  repeated entries
                </p>
                {p.status === 'missing-playlist' ? (
                  <p>Expected playlist is absent.</p>
                ) : p.status === 'ambiguous-playlist' ? (
                  <p>More than one matching folder or playlist exists.</p>
                ) : null}
                {p.examples.length ? (
                  <details>
                    <summary>Example differences (up to 5)</summary>
                    {p.examples.map((e, i) => (
                      <p key={i}>
                        {e.kind}: <code>{e.path}</code>
                      </p>
                    ))}
                  </details>
                ) : null}
              </div>
            ))}
          </details>
        </>
      ) : null}
      {report.unexpectedPlaylists ? (
        <p>
          {report.unexpectedPlaylists} unexpected playlists inside the batch folder. Examples:{' '}
          {report.unexpectedExamples.join(', ')}
        </p>
      ) : null}
      <small>
        This checks membership in the supplied XML. It does not check the current live collection,
        audio contents, playback, cues or beat grids.
      </small>
    </div>
  )
}

import { pathToFileURL } from 'node:url'
import { CATEGORY_GROUPS } from './shared'
import type { CatalogFile } from './duplicate-hashes'
export interface ExportTrack {
  track: CatalogFile
  reference: { attrs: string; tempo: string; cues: string } | null
}
export function escapeXML(value: unknown) {
  const text = String(value)
  if (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(text) ||
    /[\ud800-\udfff]/u.test(text)
  )
    throw new Error('A track contains text that cannot be represented in XML. Review its metadata.')
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\t', '&#9;')
}
const attributes = (values: Record<string, unknown>) =>
  Object.entries(values)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error('Unsupported XML attribute.')
      return `${key}="${escapeXML(value)}"`
    })
    .join(' ')
export function exportTrackXML({ track, reference }: ExportTrack, id: string | number) {
  const attrs = reference
    ? JSON.parse(reference.attrs)
    : {
        Name: track.title || track.filename,
        Artist: track.artist,
        Genre: track.genre,
        Year: track.year,
        AverageBpm: track.bpm,
        Tonality: track.key,
        TotalTime: track.duration === null ? null : Math.round(track.duration),
        Size: track.size,
        Kind: track.format,
        BitRate: track.bitrate === null ? null : Math.round(track.bitrate / 1000),
        SampleRate: track.sampleRate,
      }
  // Only the caller's conflict-free exact-path reference may supply preparation.
  attrs.TrackID = id
  attrs.Location = pathToFileURL(track.path).href.replace(/^file:\/\//, 'file://localhost')
  const children = reference
    ? [
        ...(JSON.parse(reference.tempo) as Record<string, string>[]).map(
          a => `<TEMPO ${attributes(a)}/>`
        ),
        ...(JSON.parse(reference.cues) as Record<string, string>[]).map(
          a => `<POSITION_MARK ${attributes(a)}/>`
        ),
      ].join('')
    : ''
  return `<TRACK ${attributes(attrs)}>${children}</TRACK>`
}
export function playlistFiles(tracks: ExportTrack[], namespace: string, version: string) {
  const collection: string[] = []
  const categories = new Map<string, { id: number; track: CatalogFile }[]>()
  const seen = new Set<string>()
  tracks.forEach(({ track, reference }, index) => {
    if (seen.has(track.path)) throw new Error('An export contains the same path twice.')
    seen.add(track.path)
    if (/[\r\n\0]/.test(track.path))
      throw new Error('A filename contains a line break and cannot be exported as a playlist.')
    const id = index + 1
    collection.push(exportTrackXML({ track, reference }, id))
    const list = categories.get(track.category!) || []
    list.push({ id, track })
    categories.set(track.category!, list)
  })
  const files: Record<string, string> = {}
  const folders: string[] = []
  for (const [group, names] of Object.entries(CATEGORY_GROUPS)) {
    if (group === 'WORKFLOW') continue
    const nodes: string[] = []
    for (const name of names) {
      const entries = categories.get(name)
      if (!entries?.length) continue
      nodes.push(
        `<NODE Type="1" Name="${escapeXML(name)}" KeyType="0" Entries="${entries.length}">${entries.map(t => `<TRACK Key="${t.id}"/>`).join('')}</NODE>`
      )
      // One UTF-8 fallback per category. Absolute paths; metadata and hierarchy are not transferred.
      files[`${name.replaceAll('&', 'and')}.m3u8`] =
        '#EXTM3U\n' +
        entries
          .map(
            ({ track }) =>
              `#EXTINF:${track.duration === null ? -1 : Math.round(track.duration)},${`${track.artist || ''} - ${track.title || track.filename}`.replace(/[\r\n]/g, ' ')}\n${track.path}`
          )
          .join('\n') +
        '\n'
    }
    if (nodes.length)
      folders.push(
        `<NODE Type="0" Name="${escapeXML(group)}" Count="${nodes.length}">${nodes.join('')}</NODE>`
      )
  }
  files['rekordbox.xml'] =
    `<?xml version="1.0" encoding="UTF-8"?>\n<DJ_PLAYLISTS Version="1.0.0"><PRODUCT Name="DJ Library Organizer" Version="${escapeXML(version)}" Company="Local"/><COLLECTION Entries="${tracks.length}">${collection.join('')}</COLLECTION><PLAYLISTS><NODE Type="0" Name="ROOT" Count="1"><NODE Type="0" Name="${escapeXML(namespace)}" Count="${folders.length}">${folders.join('')}</NODE></NODE></PLAYLISTS></DJ_PLAYLISTS>\n`
  if (Buffer.byteLength(files['rekordbox.xml']) > 128 * 1024 * 1024)
    throw new Error('Export exceeds the 128 MB limit. Export a smaller selection.')
  return files
}
export const IMPORT_GUIDE = `DJ Library Organizer — playlist import\n\nAudio stays at its existing paths. XML and M3U8 are playlist artifacts, not audio backups.\n\n1. Only import a batch with COMPLETE.txt present. Keep a current rekordbox library backup. In rekordbox 7, enable the rekordbox xml tree item and choose this batch's rekordbox.xml as the imported library (Preferences > Advanced > Database; labels may vary by version).\n2. Open rekordbox xml in the tree and refresh it. Expand the unique DJ Library Organizer batch folder.\n3. Import a small playlist first through the playlist context menu. Confirm playback, existing cues/loops/grids and ratings. For automatic snapshot comparison, import the dated batch folder with its genre hierarchy. Standalone playlist imports require manual checking.\n4. Do not delete/re-import existing Collection entries. Do not replace your own playlist folders. Each export uses a new dated batch namespace; repeated imports are not guaranteed to merge or remove old memberships.\n5. Export a fresh XML from rekordbox and use Refresh Rekordbox Library in the organizer then open Prepare for rekordbox > Recent exports > Check against refreshed XML. The comparison requires the dated batch folder and genre hierarchy; individual M3U8 imports are not automatically verified. A saved export does not prove it was imported.\n\nM3U8 fallback: import the individual UTF-8 playlist files via Import Playlist. This transfers membership only, not genre/year tags, cue points, grids or the nested hierarchy.\n\nTrack metadata in XML comes from a single exact-path snapshot when available, otherwise existing local metadata. Ordinary BPM, artist formatting, genre, key or year differences retain that snapshot metadata; ambiguous identity matches remain held. Reggaeton with an unconfirmed recording/version year uses the general Reggaeton playlist, leaving saved category choices and tags unchanged. Category names become playlists. Approved research does not overwrite embedded tags or existing rekordbox metadata. No cue/grid data is inferred or transferred between copies.\n\nCompatibility status: generated XML is validated against the documented format and the app's parser. Live rekordbox collection merging and repeated-import behavior remain unverified for your installation. Before repeated use, check: existing-path reuse, repeat imports, changed membership, names, metadata conflicts, and cue/grid preservation.\n\nReference: https://cdn.rekordbox.com/files/20200410160904/xml_format_list.pdf\nManual: https://rekordbox.com/en/download/#manual\n`

import type { DuplicateMember } from './preparation-types'
import path from 'node:path'
function locationScore(file: string) {
  const p = file.toLowerCase()
  if (p.includes('/music/dj library/complete/')) return 400
  if (p.includes('/complete/')) return 300
  if (p.includes('/music/dj library/') && !p.includes('/downloading/')) return 200
  if (p.includes('/music/')) return 100
  if (p.includes('/downloads/')) return 0
  return 50
}
export function bestCopy(members: DuplicateMember[]): DuplicateMember {
  if (!members.length) throw new Error('No copies available.')
  const score = (m: DuplicateMember) => [
    m.references,
    m.playlistReferences || 0,
    Number(m.cues > 0),
    m.cues,
    Number(m.grids > 0),
    m.grids,
    Number(/flac|alac|wav|aiff|pcm/i.test(m.track.format || '')),
    m.track.sampleRate || 0,
    m.track.bitrate || 0,
    locationScore(m.track.path),
  ]
  return [...members].sort((a, b) => {
    const aa = score(a),
      bb = score(b)
    for (let i = 0; i < aa.length; i++) if (aa[i] !== bb[i]) return bb[i]! - aa[i]!
    return (
      path.normalize(a.track.path).localeCompare(path.normalize(b.track.path)) ||
      a.track.id.localeCompare(b.track.id)
    )
  })[0]!
}
export function comparableVersions(members: DuplicateMember[]) {
  return (
    members.every(
      m =>
        m.track.duration !== null &&
        m.track.duration > 0 &&
        m.track.artist &&
        !/^(a|unknown|various artists)$/i.test(m.track.artist.trim())
    ) &&
    Math.max(...members.map(m => m.track.duration!)) -
      Math.min(...members.map(m => m.track.duration!)) <=
      2
  )
}

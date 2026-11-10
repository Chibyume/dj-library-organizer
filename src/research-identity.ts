import { createHash } from 'node:crypto'
import type { ResearchInput, Track } from './shared'
import { normalize } from './classification'
const hasVersion = (s: string) =>
  /\b(remix|rmx|edit|bootleg|rework|mashup|live|instrumental|acapella|a cappella|sped up|slowed|version|mix)\b/.test(
    normalize(s)
  )
export const inputDigest = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex')
const unsafeText = (value: string) =>
  /[\x00-\x1f]|(?:\/(?:Users|Volumes|private|tmp|System|Library|Applications|dev|var|home|etc)\/|file:|https?:|\\)/i.test(
    value
  ) ||
  /^\/[^/]+\//.test(value) ||
  /^(?:\.\.\/|~\/)/.test(value)
export function researchInput(track: Track): ResearchInput | null {
  const title = track.title?.trim(),
    artist = track.artist?.trim()
  if (
    !title ||
    !artist ||
    title.length > 500 ||
    artist.length > 500 ||
    unsafeText(title) ||
    unsafeText(artist)
  )
    return null
  return {
    title,
    artist,
    version: hasVersion(title) ? title.slice(0, 200) : '',
    duration: track.duration,
    taggedYear: track.year,
    taggedGenre: track.genre && !unsafeText(track.genre) ? track.genre.slice(0, 500) : null,
  }
}

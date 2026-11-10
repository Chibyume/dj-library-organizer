import type { IAudioMetadata } from 'music-metadata'
export const PARSER_REVISION = 2
const AUDIO_IDS = new Set([
  'mp4a',
  'alac',
  'Opus',
  'fLaC',
  'flac',
  '.mp3',
  'ac-3',
  'ec-3',
  'lpcm',
  'sowt',
  'twos',
])
export function readableAudio(m: IAudioMetadata) {
  return Boolean(
    m.format.codec &&
    (m.format.hasAudio === true ||
      (typeof m.format.sampleRate === 'number' && m.format.sampleRate > 0))
  )
}
export function extractMetadata(m: IAudioMetadata, partial = false) {
  const c = m.common
  const f = m.format
  const audio = f.trackInfo?.find(t => t.audio || AUDIO_IDS.has(t.codecId || ''))
  const finite = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : null)
  const text = (s: unknown) => (typeof s === 'string' ? s.slice(0, 10000) : null)
  const artist = c.artists?.length ? c.artists.join(' / ') : c.artist
  return {
    artist: text(artist),
    title: text(c.title),
    bpm: finite(c.bpm),
    year: finite(c.year),
    genre: c.genre?.join(' / ')?.slice(0, 10000) || null,
    duration: partial ? null : finite(f.duration ?? audio?.duration),
    format: text(f.codec || audio?.codecName || f.container),
    bitrate: partial ? null : finite(f.bitrate ?? audio?.bitrate),
    sampleRate: finite(f.sampleRate ?? audio?.audio?.samplingFrequency),
    key: text(c.key),
    tags: {
      artist: text(artist),
      title: text(c.title),
      bpm: finite(c.bpm),
      year: finite(c.year),
      genre: c.genre || [],
      album: text(c.album),
      date: text(c.date),
      originaldate: text(c.originaldate),
      originalyear: finite(c.originalyear),
      artists: c.artists?.slice(0, 30) || [],
      comment: c.comment?.slice(0, 10).map(v => text(typeof v === 'string' ? v : v.text)) || [],
      partialRead: partial,
    },
  }
}
export function describeMetadataError(message: string) {
  const atom = message.match(/Atom size exceeds remaining bytes: (\d+) > (\d+)/)
  if (atom)
    return `Incomplete or malformed MP4/M4A: a section declares ${Number(atom[1]).toLocaleString('en-US')} bytes, but only ${Number(atom[2]).toLocaleString('en-US')} remain. Some tags may be readable. Recheck when the download finishes; if it is finished, obtain a complete copy.`
  return message
}

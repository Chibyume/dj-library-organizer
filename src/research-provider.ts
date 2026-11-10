import { z } from 'zod'
import { normalize, propose } from './classification'
import type {
  ResearchInput,
  ResearchCandidate,
  ResearchProvider,
  ResearchResult,
  ClassificationRule,
} from './shared'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ProviderFailure } from './research-failure'
export { ProviderFailure } from './research-failure'

export const RESEARCH_REVISION = 1
export interface ResearchAdapter {
  lookup(input: ResearchInput, signal: AbortSignal): Promise<ResearchResult>
}
export function publicSource(value: string): boolean {
  try {
    const u = new URL(value)
    const h = u.hostname.toLowerCase()
    return (
      value.length <= 2048 &&
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      (!u.port || u.port === '443') &&
      /^[a-z0-9.-]+$/.test(h) &&
      h.includes('.') &&
      !/^\d/.test(h) &&
      !/\.(local|localhost|internal|test|invalid)$/.test(h) &&
      !h.endsWith('.localhost') &&
      !h.includes('..') &&
      !h.startsWith('localhost.')
    )
  } catch {
    return false
  }
}
export function categoryFor(
  input: ResearchInput,
  c: ResearchCandidate,
  rules: ClassificationRule[] = []
) {
  if (!c.sameVersion) return null
  return propose(
    {
      signature: 'proposal',
      filename: '',
      title: input.title,
      genre: c.genre,
      genres: [],
      year: null,
      originalYear: null,
      originalDate: null,
      availability: 'available',
      partial: false,
      xml: [],
      xmlOverflow: false,
      era:
        c.year && ['recording', 'version'].includes(c.yearKind)
          ? {
              year: c.year,
              kind: c.yearKind as 'recording' | 'version',
              current: true,
            }
          : null,
    },
    rules
  ).category
}
export const hasVersion = (s: string) =>
  /\b(remix|rmx|edit|bootleg|rework|mashup|live|instrumental|acapella|a cappella|sped up|slowed|version|mix)\b/.test(
    normalize(s)
  )
const text = z.string().max(500)
const credit = z
  .array(
    z
      .object({
        name: text.optional(),
        joinphrase: text.optional(),
        artist: z.object({ name: text }),
      })
      .passthrough()
  )
  .max(20)
const recording = z
  .object({
    id: z.uuid(),
    title: text,
    'artist-credit': credit,
    length: z.number().nonnegative().nullable().optional(),
    disambiguation: text.optional(),
    'first-release-date': z.string().max(20).optional(),
    genres: z
      .array(z.object({ name: text, count: z.number().optional() }))
      .max(100)
      .optional(),
  })
  .passthrough()
const artistName = (r: z.infer<typeof recording>) =>
  r['artist-credit'].map(c => (c.name || c.artist.name) + (c.joinphrase || '')).join('')
export function yearOf(date: string | null) {
  if (!date || !/^(19|20)\d{2}(?:-\d{2})?(?:-\d{2})?$/.test(date)) return null
  const [year, month, day] = date.split('-').map(Number)
  if (!year || year > new Date().getUTCFullYear()) return null
  if (month !== undefined && (month < 1 || month > 12)) return null
  if (day !== undefined && (day < 1 || day > new Date(Date.UTC(year, month!, 0)).getUTCDate()))
    return null
  if (date.length > 4 && date > new Date().toISOString().slice(0, date.length)) return null
  return year
}
export async function boundedFetch(
  url: string | URL,
  init: RequestInit,
  fetcher: typeof fetch = fetch
): Promise<Response> {
  const res = await fetcher(url, { ...init, redirect: 'error' })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    const retry = res.headers.get('retry-after')
    throw new ProviderFailure(
      res.status,
      retry && /^\d+$/.test(retry) ? Math.min(60000, Number(retry) * 1000) : 10000
    )
  }
  const limit = 3 * 1024 * 1024
  if (Number(res.headers.get('content-length')) > limit) {
    await res.body?.cancel()
    throw new ProviderFailure(413)
  }
  const reader = res.body?.getReader()
  if (!reader) throw new ProviderFailure(502)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw new ProviderFailure(413)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.length
  }
  return new Response(bytes, { status: res.status, headers: res.headers })
}
export class MusicBrainzAdapter implements ResearchAdapter {
  private next = 0
  constructor(
    private fetcher: typeof fetch = fetch,
    private interval = 1100
  ) {}
  private async request(url: URL, signal: AbortSignal) {
    await delay(Math.max(0, this.next - Date.now()), undefined, { signal })
    this.next = Date.now() + this.interval
    let attempts = 0
    while (true) {
      try {
        const res = await boundedFetch(
          url,
          {
            signal,
            headers: {
              'User-Agent':
                'DJLibraryOrganizer/0.5.1 (local desktop metadata research; https://musicbrainz.org/doc/MusicBrainz_API)',
              Accept: 'application/json',
            },
          },
          this.fetcher
        )
        return await res.json()
      } catch (e) {
        if (e instanceof ProviderFailure && [429, 503].includes(e.status) && attempts++ < 2) {
          await delay(Math.max(this.interval, e.retryAfter), undefined, {
            signal,
          })
          this.next = Date.now() + this.interval
          continue
        }
        throw e
      }
    }
  }
  async lookup(input: ResearchInput, signal: AbortSignal): Promise<ResearchResult> {
    const quote = (s: string) => '"' + s.replace(/[\\"+\-!(){}\[\]^~*?:\/|&]/g, ' ') + '"'
    const url = new URL('https://musicbrainz.org/ws/2/recording/')
    url.searchParams.set(
      'query',
      `recording:${quote(input.title)} AND artist:${quote(input.artist)}`
    )
    url.searchParams.set('fmt', 'json')
    url.searchParams.set('limit', '5')
    const list = z
      .object({ recordings: z.array(recording).max(5) })
      .passthrough()
      .parse(await this.request(url, signal))
    const ranked = list.recordings
      .map(r => ({
        r,
        exact:
          normalize(r.title) === normalize(input.title) &&
          normalize(artistName(r)) === normalize(input.artist),
      }))
      .sort((a, b) => Number(b.exact) - Number(a.exact))
    const candidates: ResearchCandidate[] = []
    for (const { r, exact } of ranked.slice(0, 3)) {
      const detail = new URL(`https://musicbrainz.org/ws/2/recording/${r.id}`)
      detail.searchParams.set('inc', 'artists+genres')
      detail.searchParams.set('fmt', 'json')
      const item = recording.parse(await this.request(detail, signal))
      const durationMatch =
        input.duration != null &&
        item.length != null &&
        Math.abs(input.duration - item.length / 1000) <= 3
      const versionInfo = item.disambiguation || ''
      const same =
        exact &&
        normalize(item.title) === normalize(input.title) &&
        normalize(artistName(item)) === normalize(input.artist) &&
        durationMatch &&
        (!hasVersion(versionInfo) || normalize(input.title).includes(normalize(versionInfo))) &&
        (!input.version || hasVersion(item.title))
      const source = `https://musicbrainz.org/recording/${item.id}`
      const genres = (item.genres || [])
        .filter(g => (g.count ?? 0) > 0)
        .map(g => g.name)
        .slice(0, 10)
      const date = item['first-release-date'] || null
      const c: ResearchCandidate = {
        title: item.title,
        artist: artistName(item),
        version: versionInfo || input.version,
        sameVersion: same,
        genre: genres.length ? genres.join('; ') : null,
        year: yearOf(date),
        date,
        yearKind: hasVersion(input.title) ? 'version' : 'recording',
        genreSources: genres.length ? [source] : [],
        yearSources: date ? [source] : [],
        sources: [{ url: source, title: 'MusicBrainz recording' }],
        reasons: [
          same
            ? 'Title, artist, version label and duration agree.'
            : 'Recording identity needs review: exact title, artist, version and duration did not all agree.',
          'Genres are community votes. Date is the earliest release currently listed for this recording; it is not proof of the earliest release worldwide.',
        ],
        category: null,
      }
      c.category = categoryFor(input, c)
      candidates.push(c)
    }
    return {
      id: randomUUID(),
      provider: 'musicbrainz',
      model: null,
      retrievedAt: new Date().toISOString(),
      candidates,
      notes: candidates.length
        ? []
        : ['No recording candidates found. DJ edits may be absent from MusicBrainz.'],
    }
  }
}
export function adapters(): Record<ResearchProvider, ResearchAdapter> {
  return { musicbrainz: new MusicBrainzAdapter() }
}

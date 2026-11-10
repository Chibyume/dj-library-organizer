// Only used by the explicit --test-profile + --smoke-report runner; never a renderer option.
import { randomUUID } from 'node:crypto'
import type { ResearchAdapter } from './research-provider'
export const syntheticResearch: ResearchAdapter = {
  lookup: async (input, signal) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 120)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new Error('Synthetic cancellation'))
        },
        { once: true }
      )
    })
    const url = 'https://musicbrainz.org/recording/00000000-0000-4000-8000-000000000001'
    return {
      id: randomUUID(),
      provider: 'musicbrainz',
      model: null,
      retrievedAt: new Date().toISOString(),
      notes: ['SYNTHETIC TEST RESPONSE — no internet request or real music claim.'],
      candidates: [
        {
          title: input.title,
          artist: input.artist,
          version: input.version,
          sameVersion: true,
          genre: 'Reggaeton',
          year: 2008,
          date: '2008',
          yearKind: 'recording',
          genreSources: [url],
          yearSources: [url],
          sources: [
            {
              url,
              title: 'Synthetic fixture source (do not use as music evidence)',
            },
          ],
          reasons: ["Generated only to verify the app's preview → lookup → approval flow."],
          category: 'Reggaeton New',
        },
      ],
    }
  },
}

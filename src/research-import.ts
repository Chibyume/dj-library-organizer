import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { LibraryDB } from './db'
import { Classifier } from './classifier'
import { inputDigest, researchInput } from './research-identity'
import { categoryFor, publicSource, yearOf } from './research-provider'
import { CATEGORIES, type ResearchImportPreview } from './shared'

const text = z.string().trim().min(1).max(500)
const url = z.string().refine(publicSource, 'Use a public HTTPS source link.')
const candidate = z
  .object({
    title: text,
    artist: text,
    version: z.string().max(500),
    sameVersion: z.literal(true),
    genre: text.nullable(),
    year: z.number().int().min(1900).max(new Date().getUTCFullYear()).nullable(),
    date: z.string().max(20).nullable(),
    yearKind: z.enum(['recording', 'version', 'release', 'unknown']),
    genreSources: z.array(url).max(10),
    yearSources: z.array(url).max(10),
    sources: z
      .array(z.object({ url, title: text }).strict())
      .min(1)
      .max(10),
    reasons: z.array(text).min(1).max(10),
    category: z.enum(CATEGORIES).nullable(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const links = new Set(c.sources.map(s => s.url))
    if (
      (!c.genre && !c.year) ||
      (c.genre && !c.genreSources.length) ||
      (c.year && (!c.yearSources.length || !c.date || yearOf(c.date) !== c.year)) ||
      (!c.year && c.date) ||
      [...c.genreSources, ...c.yearSources].some(s => !links.has(s))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Each imported value needs a matching cited source and consistent date.',
      })
  })
export const researchBundleSchema = z
  .object({
    format: z.literal('dj-library-research-v1'),
    id: z.uuid(),
    label: text,
    createdAt: z.iso.datetime(),
    entries: z
      .array(
        z
          .object({
            fileId: z.uuid(),
            signature: z.string().min(1).max(1000),
            inputHash: z.string().regex(/^[a-f0-9]{64}$/),
            candidate,
          })
          .strict()
      )
      .min(1)
      .max(2000),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (new Set(b.entries.map(e => e.fileId)).size !== b.entries.length)
      ctx.addIssue({
        code: 'custom',
        message: 'A research bundle may contain each catalog file only once.',
      })
  })
type Bundle = z.infer<typeof researchBundleSchema>
type Entry = Bundle['entries'][number]

// File imports are offline evidence supplied by the user, never another lookup provider.
export class ResearchImporter {
  private plan: {
    token: string
    bundle: Bundle
    eligible: Entry[]
    expires: number
  } | null = null
  constructor(
    private library: LibraryDB,
    private classifier: Classifier,
    private notify: () => void
  ) {}
  async choose(file: string): Promise<ResearchImportPreview> {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    let raw: string
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 6 * 1024 * 1024)
        throw new Error('Choose a research JSON file under 6 MiB.')
      const bytes = Buffer.alloc(stat.size + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      const after = await handle.stat()
      if (bytesRead !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
        throw new Error('The research file changed while reading it.')
      raw = bytes.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
    return this.preview(JSON.parse(raw))
  }
  private blocked(e: Entry, bundle: Bundle): string | null {
    const t = this.library.get(e.fileId)
    if (!t) return 'Track is absent from this catalog'
    const input = researchInput(t)
    if (
      !input ||
      (t as typeof t & { signature: string }).signature !== e.signature ||
      inputDigest(input) !== e.inputHash
    )
      return 'Track metadata changed since research'
    if (t.manual || t.review === 'Excluded') return 'Existing manual decision preserved'
    if (t.availability !== 'available') return 'File unavailable'
    if (
      !this.library.db
        .prepare(
          "SELECT 1 FROM locations l JOIN sources s ON s.id=l.sourceId WHERE l.fileId=? AND l.available=1 AND s.enabled=1 AND s.status IN ('ready','partial','cancelled','interrupted') LIMIT 1"
        )
        .get(t.id)
    )
      return 'Source unavailable, busy or disabled'
    const saved = this.library.db
      .prepare('SELECT value FROM research_approved WHERE fileId=?')
      .get(t.id) as { value: string } | undefined
    if (saved)
      return JSON.parse(saved.value).bundleId === bundle.id
        ? 'Already imported'
        : 'Saved research choice preserved'
    const era = this.library.db
      .prepare('SELECT year,kind,signature FROM era_years WHERE fileId=?')
      .get(t.id) as { year: number; kind: string; signature: string } | undefined
    if (
      era &&
      e.candidate.year &&
      ['recording', 'version'].includes(e.candidate.yearKind) &&
      (era.year !== e.candidate.year ||
        era.kind !== e.candidate.yearKind ||
        era.signature !== e.signature)
    )
      return 'Saved era year needs review'
    return null
  }
  preview(raw: unknown): ResearchImportPreview {
    const bundle = researchBundleSchema.parse(raw)
    const eligible: Entry[] = [],
      held: Record<string, number> = {}
    for (const e of bundle.entries) {
      const reason = this.blocked(e, bundle)
      if (reason) held[reason] = (held[reason] || 0) + 1
      else eligible.push(e)
    }
    const token = randomUUID(),
      expires = Date.now() + 15 * 60000
    this.plan = { token, bundle, eligible, expires }
    return {
      token,
      label: bundle.label,
      total: bundle.entries.length,
      eligible: eligible.length,
      held,
      examples: eligible.slice(0, 30).map(e => ({
        title: e.candidate.title,
        artist: e.candidate.artist,
        genre: e.candidate.genre,
        year: e.candidate.year,
        reasons: e.candidate.reasons,
        sources: e.candidate.sources,
      })),
    }
  }
  apply(token: string) {
    const plan = this.plan
    if (!plan || token !== plan.token || Date.now() > plan.expires)
      throw new Error('Preview the research file again.')
    const approvedAt = new Date().toISOString()
    this.library.db.transaction(() => {
      for (const e of plan.eligible) {
        if (this.blocked(e, plan.bundle))
          throw new Error(
            'The library changed. Preview the research file again; nothing was imported.'
          )
        const track = this.library.get(e.fileId)!
        const c = {
          ...e.candidate,
          category: categoryFor(researchInput(track)!, e.candidate, this.classifier.rules()),
        }
        const value = JSON.stringify({
          candidate: c,
          resultId: plan.bundle.id,
          provider: 'imported research',
          sources: c.sources,
          bundleId: plan.bundle.id,
          label: plan.bundle.label,
        })
        this.library.db
          .prepare('INSERT INTO research_approved VALUES(?,?,?,?,?)')
          .run(track.id, e.signature, e.inputHash, value, approvedAt)
        if (
          c.year &&
          ['recording', 'version'].includes(c.yearKind) &&
          !this.library.db.prepare('SELECT 1 FROM era_years WHERE fileId=?').get(track.id)
        )
          this.classifier.eraYear({
            id: track.id,
            revision: track.revision,
            year: c.year,
            kind: c.yearKind as 'recording' | 'version',
            note: `Research approval: ${plan.bundle.id}`,
          })
        else
          this.library.db.prepare('UPDATE files SET revision=revision+1 WHERE id=?').run(track.id)
        this.library.db
          .prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?)')
          .run(randomUUID(), track.id, 'research', null, value, approvedAt, track.revision + 1)
      }
    })()
    this.plan = null
    if (this.classifier.state().automatic) this.classifier.start()
    this.notify()
    return { imported: plan.eligible.length }
  }
}

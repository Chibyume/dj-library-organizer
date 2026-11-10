import type { Category, ClassificationProposal, ClassificationRule, RuleDraft } from './shared'

export const CLASSIFIER_REVISION = 4
export interface ClassificationInput {
  research?: { genre: string | null; source: string; current: boolean }
  signature: string
  filename: string
  title: string | null
  genre: string | null
  genres: string[]
  year: number | null
  originalYear: number | null
  originalDate: string | null
  availability: string
  partial: boolean
  xml: {
    genre: string
    year: string
    title: string
    identityConflict: boolean
  }[]
  xmlOverflow: boolean
  playlists?: string[]
  era: {
    year: number
    kind: 'recording' | 'version'
    current: boolean
    note?: string
    confirmedAt?: string
  } | null
}
export function normalize(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}
const aliases: [string, Category | 'Reggaeton'][] = [
  ['dembow', 'Dembow'],
  ['dominican dembow', 'Dembow'],
  ['merengue', 'Merengue'],
  ['merengue tipico', 'Merengue'],
  ['bachata', 'Bachata'],
  ['salsa', 'Salsa'],
  ['cumbia', 'Cumbia'],
  ['plena', 'Plena'],
  ['plena fusion', 'Plena'],
  ['afrobeats', 'Afrobeats'],
  ['afrobeat', 'Afrobeats'],
  ['dancehall', 'Dancehall'],
  ['rock', 'Rock'],
  ['alternative rock', 'Rock'],
  ['reggaeton', 'Reggaeton'],
  ['reggaetón', 'Reggaeton'],
  ['neoperreo', 'Reggaeton'],
  ['latin r&b', 'Latin R&B'],
  ['latin rnb', 'Latin R&B'],
  ['r&b latino', 'Latin R&B'],
  ...[
    'latin other',
    'mambo',
    'cha cha cha',
    'bolero',
    'bomba',
    'jibaro',
    'puerto rican folk',
    'latin ballad',
  ].map((x): [string, Category] => [x, 'Latin Other']),
  ...['jersey club', 'baltimore club', 'philly club', 'philadelphia club', 'bmore club'].map(
    (x): [string, Category] => [x, 'Jersey Club']
  ),
  ...['new orleans bounce', 'nola bounce', 'bounce', 'twerk', 'miami bass'].map(
    (x): [string, Category] => [x, 'Bounce']
  ),
  ...['hip hop', 'hiphop', 'rap', 'hip hop rap', 'trap', 'trap hip hop'].map(
    (x): [string, Category] => [x, 'Hip Hop']
  ),
  ...[
    'r&b',
    'rnb',
    'rhythm and blues',
    'contemporary r&b',
    'alternative r&b',
    'soul',
    'neo soul',
  ].map((x): [string, Category] => [x, 'R&B']),
  ['pop', 'Pop'],
  ['dance pop', 'Pop'],
  ['synthpop', 'Pop'],
  ...[
    'synth pop',
    'k pop',
    'latin pop',
    'alternative pop',
    'pop rock',
    'pop punk',
    'teen pop',
    'bubblegum pop',
    'electropop',
  ].map((x): [string, Category] => [x, 'Pop']),
  ...[
    'dance',
    'edm',
    'electronic',
    'electronica',
    'house',
    'tech house',
    'deep house',
    'progressive house',
    'techno',
    'trance',
    'electro',
    'disco',
    'nu disco',
    'drum and bass',
    'drum & bass',
    'dnb',
    'dubstep',
    'garage',
    'uk garage',
    'afro house',
    'bass house',
    'electro house',
    'hip house',
    'breakbeat',
  ].map((x): [string, Category] => [x, 'Dance']),
]
const genreMap = new Map(aliases.map(([name, category]) => [normalize(name), category]))
function genreValues(input: ClassificationInput): { value: string; source: string }[] {
  const embedded = input.genres.length ? input.genres : input.genre ? [input.genre] : []
  const values = embedded.map(value => ({ value, source: 'Embedded genre' }))
  for (let i = 0; i < input.xml.length; i++) {
    const entry = input.xml[i]!
    if (!entry.identityConflict && entry.genre)
      values.push({
        value: entry.genre,
        source: `rekordbox snapshot genre ${i + 1}`,
      })
  }
  if (input.research?.current && input.research.genre)
    values.push({ value: input.research.genre, source: input.research.source })
  return values
    .slice(0, 60)
    .flatMap(({ value, source }) => splitGenre(value).map(part => ({ value: part, source })))
}
function splitGenre(value: string) {
  return genreMap.has(normalize(value)) ? [value] : value.split(/\s*[/;,|]\s*/).slice(0, 10)
}
export function matchesRule(input: ClassificationInput, rule: RuleDraft) {
  const match = normalize(rule.match)
  if (!match) return false
  if (rule.field === 'genre') return genreValues(input).some(g => normalize(g.value) === match)
  return [input.title || '', input.filename].some(v => ` ${normalize(v)} `.includes(` ${match} `))
}
export function propose(
  input: ClassificationInput,
  rules: ClassificationRule[] = []
): ClassificationProposal {
  const result: ClassificationProposal = {
    category: null,
    genre: null,
    status: 'Needs Manual Classification',
    basis: 'needs review',
    reasons: [],
    evidence: [],
    candidates: [],
    eraYear: null,
  }
  const genres = genreValues(input),
    found = new Set<Category | 'Reggaeton'>()
  result.genre = input.genre || genres.map(g => g.value).join(' / ') || null
  for (const g of genres) {
    const mapped = genreMap.get(normalize(g.value))
    result.evidence.push({
      source: g.source,
      value: g.value.slice(0, 250),
      meaning: mapped ? `Maps to ${mapped}` : 'No unambiguous category mapping',
    })
    if (mapped) found.add(mapped)
  }
  if (input.year)
    result.evidence.push({
      source: 'Embedded release/album year',
      value: String(input.year),
      meaning: 'Evidence only; may describe a reissue or compilation',
    })
  if (input.originalYear || input.originalDate)
    result.evidence.push({
      source: 'Embedded original release date',
      value: input.originalDate || String(input.originalYear),
      meaning: 'Evidence only; the recording/version has not been verified',
    })
  for (const x of input.xml)
    if (x.year)
      result.evidence.push({
        source: 'rekordbox snapshot year',
        value: x.year,
        meaning: 'Snapshot evidence; not a verified recording date',
      })
  const labels = [input.title || '', input.filename].map(normalize)
  const label = labels.join(' | ')
  const versionCandidates = new Set<Category | 'Reggaeton'>()
  // Explicit style + version phrases establish a target remix style, not an artist or an isolated keyword.
  const versionExpressions: [RegExp, Category | 'Reggaeton'][] = [
    [
      /\b(jersey|baltimore|philly|philadelphia|bmore) club (remix|edit|bootleg|mix|version)\b/,
      'Jersey Club',
    ],
    [/\b(new orleans bounce|nola bounce|miami bass) (remix|edit|bootleg|mix|version)\b/, 'Bounce'],
    [/\bbachata (remix|edit|version)\b/, 'Bachata'],
    [/\bmerengue (remix|edit|version)\b/, 'Merengue'],
    [/\bdembow (remix|edit|version)\b/, 'Dembow'],
    [/\breggaeton (remix|edit|version)\b/, 'Reggaeton'],
    [/\blatin r b (remix|edit|version)\b/, 'Latin R&B'],
  ]
  for (const [expression, category] of versionExpressions) {
    const match = labels.map(text => text.match(expression)).find(Boolean)
    if (match) {
      versionCandidates.add(category)
      result.evidence.push({
        source: 'Title / filename version label',
        value: match[0],
        meaning: `Explicit target style: ${category}`,
      })
    }
  }
  const matchedRules = rules.filter(r => matchesRule(input, r))
  const playlistCategories = new Set<Category | 'Reggaeton'>()
  for (const playlist of (input.playlists || []).slice(0, 20)) {
    const label = ` ${normalize(playlist)} `
    const categories = new Set<Category | 'Reggaeton'>()
    for (const [alias, category] of genreMap)
      if (label.includes(` ${alias} `)) categories.add(category)
    // A named subtype includes its broad parent; keep the specific playlist intent.
    if (categories.has('Latin R&B')) categories.delete('R&B')
    if (categories.size) {
      for (const category of categories) playlistCategories.add(category)
      result.evidence.push({
        source: 'Exact file membership in rekordbox snapshot',
        value: playlist.slice(0, 250),
        meaning: `Playlist suggests ${[...categories].join(' / ')}; membership is organization evidence, not an audio measurement`,
      })
    }
  }
  const researched = new Set<Category | 'Reggaeton'>()
  if (input.research?.current && input.research.genre)
    for (const value of splitGenre(input.research.genre)) {
      const mapped = genreMap.get(normalize(value))
      if (mapped) researched.add(mapped)
    }
  // An approved exact-version research choice is stronger than broad album tags.
  // Keep every tag visible as evidence, but do not let it veto that saved choice.
  let decision = matchedRules.length
    ? new Set(matchedRules.map(r => r.category as Category | 'Reggaeton'))
    : versionCandidates.size
      ? versionCandidates
      : researched.size
        ? researched
        : playlistCategories.size
          ? playlistCategories
          : found
  if (matchedRules.length) {
    result.basis = 'explicit rule'
    for (const rule of matchedRules)
      result.evidence.push({
        source: 'Your saved rule',
        value: `${rule.field}: ${rule.match}`,
        meaning: `Proposes ${rule.category}`,
      })
  } else if (versionCandidates.size) {
    result.basis = 'version label'
    if (found.size)
      result.reasons.push(
        'The explicit remix/edit style takes precedence over general genre tags for this version.'
      )
  } else if (researched.size) {
    result.basis = 'approved research'
    result.reasons.push(
      'Current approved research for this recording/version takes precedence over general embedded and snapshot genre tags. Those tags remain visible below.'
    )
  } else if (playlistCategories.size) {
    result.basis = 'playlist membership'
    result.reasons.push(
      'Placed using genre labels in your existing rekordbox playlists and an exact file reference in the imported snapshot.'
    )
  } else if (found.size) result.basis = 'clear metadata'
  const categories = (items: Set<Category | 'Reggaeton'>): Category[] => [
    ...new Set(
      [...items].flatMap(c =>
        c === 'Reggaeton' ? (['Reggaeton Old', 'Reggaeton New'] as Category[]) : [c]
      )
    ),
  ]
  result.candidates = categories(decision)
  if (input.xmlOverflow || input.xml.some(x => x.identityConflict)) {
    result.status = 'Conflicting Evidence'
    result.reasons.push(
      'The XML reference has conflicting recording/version identity or too many references. Compare the snapshot before classifying.'
    )
  } else if (decision.size > 1) {
    result.status = 'Conflicting Evidence'
    if (matchedRules.length || versionCandidates.size) {
      result.reasons.push(
        'Explicit rules or version labels disagree. Choose a category before placing this track.'
      )
    } else {
      result.category = [...decision][0]!
      result.basis = 'best fit'
      result.reasons.push(
        `Tentatively placed in ${result.category} using the first recognized ${researched.size ? 'approved research style' : playlistCategories.size ? 'playlist genre' : 'embedded or snapshot genre'}. Other styles point elsewhere; review this placement before export.`
      )
    }
  } else if (decision.size === 1) {
    const category = [...decision][0]!
    const reggaeton =
      category === 'Reggaeton' || category === 'Reggaeton Old' || category === 'Reggaeton New'
    result.genre = reggaeton
      ? 'Reggaeton'
      : matchedRules.length
        ? input.genre || genres[0]?.value || null
        : versionCandidates.size
          ? result.evidence
              .find(e => e.source === 'Title / filename version label')
              ?.value.replace(/ (remix|edit|bootleg|mix|version)$/, '') || null
          : researched.size
            ? input.research!.genre
            : genres.map(g => g.value).join(' / ') || null
    if (reggaeton) {
      if (!input.era?.current) {
        result.category = 'Reggaeton'
        result.status =
          input.year || input.originalYear || input.originalDate || input.xml.some(x => x.year)
            ? 'Verify Release Year'
            : 'Missing Year'
        result.reasons.push(
          input.era
            ? 'The file changed after its year was confirmed. Confirm the year for this version again.'
            : 'Confirm the earliest release year of this recording, or the release year of this remix/edit. Tag and snapshot years alone do not establish the era.'
        )
        result.candidates = ['Reggaeton Old', 'Reggaeton New']
      } else {
        result.eraYear = input.era.year
        const eraCategory = input.era.year <= 2007 ? 'Reggaeton Old' : 'Reggaeton New'
        if (category !== 'Reggaeton' && category !== eraCategory) {
          result.status = 'Conflicting Evidence'
          result.reasons.push("The saved rule's era conflicts with the confirmed release year.")
        } else {
          result.category = eraCategory
          result.status = 'Ready for Approval'
          result.reasons.push(
            `Your confirmed ${input.era.kind} year ${input.era.year} uses the ${input.era.year <= 2007 ? '2007-and-earlier' : '2008-and-later'} boundary.`
          )
        }
      }
    } else {
      result.category = category
      result.status = 'Ready for Approval'
      result.reasons.push(
        matchedRules.length
          ? 'Matched an explicit rule you previewed and saved.'
          : versionCandidates.size
            ? 'Matched a specific style and remix/edit version label.'
            : researched.size
              ? 'Placed using the current approved research genre.'
              : playlistCategories.size
                ? 'Matched a genre-labelled playlist in your supplied snapshot.'
                : 'Recognized a clear genre tag in your category vocabulary.'
      )
    }
  } else {
    result.genre = input.genre || genres[0]?.value || null
    // A plain word in a song title is weak evidence; never silently assign it.
    for (const [alias, category] of genreMap)
      if (` ${label} `.includes(` ${alias} `)) {
        result.candidates.push(...categories(new Set([category])))
      }
    result.candidates = [...new Set(result.candidates)].slice(0, 6)
    if (result.candidates.length)
      result.reasons.push(
        'A genre word in the title/filename is not enough to establish the style. Add a rule or choose a category.'
      )
    else
      result.reasons.push(
        'No clear genre or explicit version label was found. Artist, language, BPM, duration, and filename numbers do not determine a category.'
      )
  }
  if (
    result.status === 'Ready for Approval' &&
    !matchedRules.length &&
    !versionCandidates.size &&
    !researched.size &&
    playlistCategories.size &&
    [...found].some(
      c => c !== result.category && !(c === 'Reggaeton' && result.category?.startsWith('Reggaeton'))
    )
  ) {
    result.status = 'Conflicting Evidence'
    result.basis = 'best fit'
    result.candidates = [...new Set([...result.candidates, ...categories(found)])]
    result.reasons.push(
      'The existing playlist and genre tags disagree. The playlist placement is visible, but needs review before export.'
    )
  }
  if (
    !result.category &&
    result.status === 'Needs Manual Classification' &&
    genres.some(g => normalize(g.value) === 'latin')
  ) {
    result.category = 'Latin Other'
    result.status = 'Needs Review'
    result.basis = 'best fit'
    result.reasons = [
      'The broad Latin tag supports a temporary place in Latin Other, but does not identify Dembow, Bachata or Reggaeton. Review the specific style before export.',
    ]
  }
  const mix = labels.some(text =>
    /\b(dj set|dj mix|recorded set|full dj set|continuous dj mix)\b/.test(text)
  )
  const junk =
    genres.some(g => /^(loop samples|sample pack|sound effects)$/.test(normalize(g.value))) ||
    labels.some(text => /\b(sample pack|drum loop|sound effect|sfx pack)\b/.test(text))
  if (mix || junk) {
    result.candidates = [...new Set([...result.candidates, mix ? '_MIXES' : '_JUNK'] as Category[])]
    result.category = mix ? '_MIXES' : '_JUNK'
    result.status = 'Needs Review'
    result.reasons.push(
      `The metadata explicitly describes ${mix ? 'a DJ set/mix' : 'sample/loop material'}. Placed in ${result.category} for review; this does not delete or move the file.`
    )
  }
  if (input.partial || input.availability !== 'available') {
    result.category = null
    result.status = 'File Unavailable'
    result.reasons.push(
      'The file is unavailable or its metadata read is incomplete. Resolve that before accepting a suggestion.'
    )
  }
  if (input.era?.current)
    result.evidence.push({
      source: 'Your confirmed era year',
      value: String(input.era.year),
      meaning: `Applies to this ${input.era.kind} and current file signature`,
    })
  result.evidence = result.evidence.slice(0, 80)
  return result
}

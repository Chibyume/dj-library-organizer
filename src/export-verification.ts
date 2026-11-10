import path from 'node:path'
import { z } from 'zod'
import type { LibraryDB } from './db'
import { MUSIC_CATEGORIES, CATEGORY_GROUPS } from './shared'
import type { ExportRecord, ExportVerification, PlaylistVerification } from './preparation-types'

const manifestSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  namespace: z.string(),
  tracks: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine(p => path.isAbsolute(p) && !p.includes('\0')),
        category: z.enum(MUSIC_CATEGORIES),
      })
    )
    .min(1)
    .max(100000),
  files: z.array(z.object({ name: z.string(), sha256: z.string() })).max(32),
})
type Snapshot = {
  id: string
  hash: string
  importedAt: string
  modifiedAt: string
  sourcePath: string
  product: string
}
type Node = {
  id: string
  parentId: string | null
  name: string
  type: string
  ordinal: number
}
const canonical = (p: string) => path.normalize(p).normalize('NFC')
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

// Compare immutable exported membership to a supplied snapshot. This is never
// a live collection, file-content, cue, grid, or playback verification.
export async function verifyExport(
  library: LibraryDB,
  record: ExportRecord,
  rawManifest: string,
  guard: () => void
): Promise<ExportVerification> {
  const db = library.db
  const manifest = manifestSchema.parse(JSON.parse(rawManifest))
  if (
    manifest.id !== record.id ||
    manifest.namespace !== record.namespace ||
    manifest.tracks.length !== record.tracks
  )
    throw new Error('Export history and manifest disagree. This batch cannot be checked.')
  const snapshot = db
    .prepare(
      'SELECT id,hash,importedAt,modifiedAt,sourcePath,product FROM rb_snapshots WHERE active=1'
    )
    .get() as Snapshot | undefined
  const report: ExportVerification = {
    checkedAt: new Date().toISOString(),
    snapshot: snapshot || null,
    status: 'inconclusive',
    current: true,
    message:
      'Refresh Rekordbox Library with a new XML exported from rekordbox after importing this batch.',
    expected: manifest.tracks.length,
    matched: 0,
    playlists: [],
    unexpectedPlaylists: 0,
    unexpectedExamples: [],
  }
  guard()
  if (!snapshot) return report
  const checkpoint = async () => {
    await tick()
    guard()
    const active = db.prepare('SELECT id FROM rb_snapshots WHERE active=1').get() as
      { id: string } | undefined
    if (active?.id !== snapshot.id)
      throw new Error('The active snapshot changed. Check this batch again.')
  }
  const ownHash = manifest.files.find(f => f.name === 'rekordbox.xml')?.sha256
  if (
    !/^rekordbox(?:\s|$)/i.test(snapshot.product) ||
    snapshot.hash === ownHash ||
    canonical(snapshot.sourcePath) === canonical(path.join(record.directory, 'rekordbox.xml'))
  ) {
    report.message =
      "Choose a fresh XML exported from rekordbox. The organizer's generated XML and other products cannot establish an import."
    return report
  }
  const after = Date.parse(record.completedAt || record.createdAt)
  const modified = Date.parse(snapshot.modifiedAt),
    imported = Date.parse(snapshot.importedAt)
  if (
    !Number.isFinite(after) ||
    !Number.isFinite(modified) ||
    !Number.isFinite(imported) ||
    modified <= after ||
    imported <= after ||
    modified > Date.now() + 300000
  ) {
    report.message =
      'This snapshot is older than the completed batch or has an uncertain file date. Export a fresh XML from rekordbox and refresh it here.'
    return report
  }
  const expected = new Map<string, Set<string>>()
  const allPaths = new Set<string>()
  for (let i = 0; i < manifest.tracks.length; i++) {
    const t = manifest.tracks[i]!,
      p = canonical(t.path)
    if (allPaths.has(p))
      throw new Error('The batch contains ambiguous normalized paths. Prepare a new export.')
    allPaths.add(p)
    const list = expected.get(t.category) || new Set<string>()
    list.add(p)
    expected.set(t.category, list)
    if (i % 500 === 499) await checkpoint()
  }
  const nodes: Node[] = []
  const children = new Map<string, Node[]>()
  let cursor = -1
  const getNodes = db.prepare(
    'SELECT id,parentId,name,type,ordinal FROM rb_nodes WHERE snapshotId=? AND ordinal>? ORDER BY ordinal LIMIT 1000'
  )
  while (true) {
    const batch = getNodes.all(snapshot.id, cursor) as Node[]
    if (!batch.length) break
    for (const node of batch) {
      nodes.push(node)
      const group = children.get(node.parentId || '') || []
      group.push(node)
      children.set(node.parentId || '', group)
    }
    cursor = batch.at(-1)!.ordinal
    await checkpoint()
  }
  const namespaces = nodes.filter(n => n.type === 'folder' && n.name === record.namespace)
  if (namespaces.length > 1) {
    report.message =
      'More than one folder has this batch name. The snapshot is ambiguous; resolve the duplicate batch folders in rekordbox and export a new XML.'
    return report
  }
  const namespace = namespaces[0]
  const collection = new Map<string, number>()
  if (namespace) {
    let key = ''
    const getTracks = db.prepare(
      "SELECT trackKey,localPath FROM rb_tracks WHERE snapshotId=? AND trackKey>? AND refKind='local' AND localPath IS NOT NULL ORDER BY trackKey LIMIT 1000"
    )
    while (true) {
      const batch = getTracks.all(snapshot.id, key) as {
        trackKey: string
        localPath: string
      }[]
      if (!batch.length) break
      for (const t of batch) {
        const p = canonical(t.localPath)
        if (allPaths.has(p)) collection.set(p, (collection.get(p) || 0) + 1)
      }
      key = batch.at(-1)!.trackKey
      await checkpoint()
    }
  }
  const recognized = new Set<string>()
  const getMembers = db.prepare(
    'SELECT m.ordinal,t.localPath,t.refKind FROM rb_memberships m LEFT JOIN rb_tracks t ON t.snapshotId=m.snapshotId AND t.trackKey=m.trackKey WHERE m.snapshotId=? AND m.nodeId=? AND m.ordinal>? ORDER BY m.ordinal LIMIT 500'
  )
  for (const [category, paths] of expected) {
    const groupName = Object.entries(CATEGORY_GROUPS).find(
      ([group, categories]) =>
        group !== 'WORKFLOW' && (categories as readonly string[]).includes(category)
    )![0]
    const groups = namespace
      ? (children.get(namespace.id) || []).filter(n => n.type === 'folder' && n.name === groupName)
      : []
    const playlists = groups.flatMap(g =>
      (children.get(g.id) || []).filter(n => n.type === 'playlist' && n.name === category)
    )
    for (const p of playlists) recognized.add(p.id)
    const entry: PlaylistVerification = {
      category,
      group: groupName,
      status: 'matched',
      expected: paths.size,
      matched: 0,
      missing: 0,
      ambiguous: 0,
      extra: 0,
      unresolved: 0,
      duplicateEntries: 0,
      examples: [],
    }
    const example = (kind: 'missing' | 'ambiguous' | 'extra', p: string) => {
      if (entry.examples.length < 5) entry.examples.push({ kind, path: p })
    }
    if (groups.length > 1 || playlists.length > 1) {
      entry.status = 'ambiguous-playlist'
      entry.ambiguous = paths.size
    } else if (!playlists.length) {
      entry.status = 'missing-playlist'
      entry.missing = paths.size
      for (const p of paths) {
        example('missing', p)
        if (entry.examples.length === 5) break
      }
    } else {
      const seen = new Map<string, number>()
      let ordinal = -1
      while (true) {
        const batch = getMembers.all(snapshot.id, playlists[0]!.id, ordinal) as {
          ordinal: number
          localPath: string | null
          refKind: string | null
        }[]
        if (!batch.length) break
        for (const m of batch) {
          if (!m.localPath || m.refKind !== 'local') {
            entry.unresolved++
            continue
          }
          const p = canonical(m.localPath)
          seen.set(p, (seen.get(p) || 0) + 1)
          if (!paths.has(p)) {
            entry.extra++
            example('extra', p)
          }
        }
        ordinal = batch.at(-1)!.ordinal
        await checkpoint()
      }
      for (const n of seen.values()) entry.duplicateEntries += Math.max(0, n - 1)
      let checked = 0
      for (const p of paths) {
        if (!seen.has(p)) {
          entry.missing++
          example('missing', p)
        } else if (seen.get(p) !== 1 || collection.get(p) !== 1) {
          entry.ambiguous++
          example('ambiguous', p)
        } else entry.matched++
        if (++checked % 500 === 0) await checkpoint()
      }
      if (
        entry.missing ||
        entry.ambiguous ||
        entry.extra ||
        entry.unresolved ||
        entry.duplicateEntries
      )
        entry.status = 'differences'
    }
    report.playlists.push(entry)
    report.matched += entry.matched
    await checkpoint()
  }
  // Inspect only this namespace. Unrelated native playlists are not discrepancies.
  if (namespace) {
    const pending = [namespace.id]
    let visited = 0
    while (pending.length) {
      const id = pending.pop()!
      for (const n of children.get(id) || []) {
        if (n.type === 'folder') pending.push(n.id)
        else if (!recognized.has(n.id)) {
          report.unexpectedPlaylists++
          if (report.unexpectedExamples.length < 5) report.unexpectedExamples.push(n.name)
        }
      }
      if (++visited % 500 === 0) await checkpoint()
    }
  }
  report.status =
    report.playlists.every(p => p.status === 'matched') && !report.unexpectedPlaylists
      ? 'matched'
      : 'differences'
  report.message =
    report.status === 'matched'
      ? 'All exported paths and genre playlist memberships match this XML snapshot. Playback, file contents, cues and grids still need checking in rekordbox.'
      : namespace
        ? 'This XML contains missing, extra or ambiguous playlist entries. Review the differences before using this batch.'
        : 'The dated batch folder is absent from this XML. Import the batch folder with its hierarchy, then export a fresh XML. Individually imported M3U8 playlists cannot establish a batch match.'
  await checkpoint()
  return report
}

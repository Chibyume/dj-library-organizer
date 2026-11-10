import { parentPort, workerData } from 'node:worker_threads'
import { open, chmod } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import sax from 'sax'
import Database from 'better-sqlite3'
import { STAGE_SCHEMA, XML_LIMITS as L } from './xml-schema'

export function reference(location: string): {
  localPath: string | null
  refKind: string
} {
  try {
    const url = new URL(location)
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost'))
      return { localPath: null, refKind: 'nonlocal' }
    if (url.search || url.hash || url.username || url.password)
      return { localPath: null, refKind: 'invalid' }
    const p = fileURLToPath(url)
    if (!path.isAbsolute(p) || p.includes('\0')) throw new Error()
    return { localPath: path.normalize(p).normalize('NFC'), refKind: 'local' }
  } catch {
    return { localPath: null, refKind: 'invalid' }
  }
}
async function run() {
  const { source, stage, raw, expected } = workerData
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const first = await input.stat({ bigint: true })
  const time = (s: string) => {
    const [sec, nano] = s.split(':')
    return BigInt(sec!) * 1000000000n + BigInt(nano!)
  }
  const same = (s: typeof first) =>
    s.isFile() &&
    String(s.dev) === expected.device &&
    String(s.ino) === expected.inode &&
    s.size === BigInt(expected.size) &&
    s.mtimeNs === time(expected.mtime) &&
    s.ctimeNs === time(expected.ctime)
  if (!same(first) || first.size <= 0 || first.size > BigInt(L.bytes)) {
    await input.close()
    throw new Error('XML changed or exceeds the 256 MiB limit.')
  }
  const output = await open(raw, 'wx', 0o600)
  const db = new Database(stage)
  db.exec(STAGE_SCHEMA)
  const addTrack = db.prepare('INSERT INTO tracks VALUES(?,?,?,?,?,?)')
  const addNode = db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?)')
  const addMember = db.prepare('INSERT INTO memberships VALUES(?,?,?,?,NULL)')
  db.exec('BEGIN')
  const parser = sax.parser(true, {
    trim: false,
    normalize: false,
    strictEntities: true,
  } as sax.SAXOptions & { strictEntities: boolean })
  ;(sax as typeof sax & { MAX_BUFFER_LENGTH: number }).MAX_BUFFER_LENGTH = L.token
  type Frame = {
    name: string
    attrs: Record<string, string>
    id?: string
    children: number
    declared?: number
  }
  const stack: Frame[] = []
  let roots = 0,
    products = 0,
    collections = 0,
    playlistSections = 0,
    tracks = 0,
    nodes = 0,
    memberships = 0,
    playlistCount = 0,
    declaredTracks: number | undefined
  let current: {
    key: string
    attrs: Record<string, string>
    tempo: Record<string, string>[]
    cues: Record<string, string>[]
    bytes: number
  } | null = null
  let product = 'Unknown product',
    bytes = 0,
    lastProgress = 0
  const warnings: string[] = []
  const integer = (v: string | undefined, label: string) => {
    if (v === undefined) return undefined
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)))
      throw new Error(`Invalid ${label} count.`)
    return Number(v)
  }
  const warn = (message: string) => {
    if (warnings.length < 30 && !warnings.includes(message)) warnings.push(message)
  }
  parser.ondoctype = () => {
    throw new Error('DTD and entity declarations are not allowed.')
  }
  parser.onerror = e => {
    throw new Error(`Malformed XML: ${e.message.slice(0, 250)}`)
  }
  parser.onprocessinginstruction = ({ name, body }) => {
    if (
      name.toLowerCase() === 'xml' &&
      /encoding\s*=/.test(body) &&
      !/encoding\s*=\s*['"]utf-8['"]/i.test(body)
    )
      throw new Error('Only UTF-8 rekordbox XML is supported.')
  }
  parser.ontext = text => {
    if (text.length > L.token) throw new Error('XML text exceeds the limit.')
  }
  parser.onopentag = tag => {
    if (stack.length >= L.depth) throw new Error('XML nesting exceeds the limit.')
    const attrs = Object.create(null) as Record<string, string>
    if (Object.keys(tag.attributes).length > 80) throw new Error('Too many XML attributes.')
    for (const [key, value] of Object.entries(tag.attributes)) {
      if (key.length > 100 || String(value).length > L.attribute)
        throw new Error('XML attribute exceeds the limit.')
      attrs[key] = String(value)
    }
    const attributeBytes = Buffer.byteLength(JSON.stringify(attrs))
    if (attributeBytes > 65536) throw new Error('XML attributes exceed the per-element limit.')
    const parent = stack.at(-1)
    const f: Frame = { name: tag.name, attrs, children: 0 }
    if (!parent) {
      if (++roots !== 1 || tag.name !== 'DJ_PLAYLISTS')
        throw new Error('Choose a rekordbox DJ_PLAYLISTS XML export.')
    } else if (tag.name === 'PRODUCT' && parent.name === 'DJ_PLAYLISTS') {
      if (++products > 1) throw new Error('Duplicate PRODUCT element.')
      product = [attrs.Name, attrs.Version].filter(Boolean).join(' ') || 'Unknown product'
    } else if (tag.name === 'COLLECTION' && parent.name === 'DJ_PLAYLISTS') {
      if (++collections > 1) throw new Error('Duplicate COLLECTION element.')
      declaredTracks = integer(attrs.Entries, 'collection')
    } else if (tag.name === 'PLAYLISTS' && parent.name === 'DJ_PLAYLISTS') {
      if (++playlistSections > 1) throw new Error('Duplicate PLAYLISTS element.')
    } else if (tag.name === 'TRACK' && parent.name === 'COLLECTION') {
      if (++tracks > L.tracks) throw new Error('XML exceeds the 250,000-track limit.')
      if (!attrs.TrackID || !/^-?\d+$/.test(attrs.TrackID) || !attrs.Location)
        throw new Error('Each collection track needs a numeric TrackID and Location.')
      current = {
        key: attrs.TrackID,
        attrs,
        tempo: [],
        cues: [],
        bytes: attributeBytes,
      }
    } else if (
      current &&
      parent.name === 'TRACK' &&
      (tag.name === 'TEMPO' || tag.name === 'POSITION_MARK')
    ) {
      const values = tag.name === 'TEMPO' ? current.tempo : current.cues
      current.bytes += attributeBytes
      if (current.bytes > 262144)
        throw new Error('Track metadata/preparation exceeds the 256 KiB limit.')
      if (values.length >= L.preparation)
        throw new Error('Too many preparation markers in a track.')
      values.push(attrs)
    } else if (tag.name === 'NODE' && (parent.name === 'PLAYLISTS' || parent.name === 'NODE')) {
      if (parent.name === 'NODE' && parent.attrs.Type !== '0')
        throw new Error('Playlist nodes cannot contain folders.')
      if (++nodes > L.nodes || !['0', '1'].includes(attrs.Type || '') || attrs.Name === undefined)
        throw new Error('Invalid playlist node or node limit exceeded.')
      if (attrs.Type === '1' && !['0', '1'].includes(attrs.KeyType || ''))
        throw new Error('Unsupported playlist KeyType.')
      f.id = String(nodes)
      f.declared = integer(attrs.Type === '0' ? attrs.Count : attrs.Entries, 'node')
      parent.children++
      if (attrs.Type === '1') playlistCount++
      addNode.run(
        f.id,
        parent.id || null,
        attrs.Name,
        attrs.Type === '0' ? 'folder' : 'playlist',
        attrs.KeyType || null,
        0,
        stack.filter(s => s.name === 'NODE').length,
        nodes
      )
    } else if (tag.name === 'TRACK' && parent.name === 'NODE') {
      if (parent.attrs.Type !== '1' || attrs.Key === undefined || ++memberships > L.memberships)
        throw new Error('Invalid playlist membership or membership limit exceeded.')
      addMember.run(parent.id, parent.children++, attrs.Key, parent.attrs.KeyType)
    } else if (['TRACK', 'NODE', 'COLLECTION', 'PLAYLISTS'].includes(tag.name)) {
      throw new Error(`Unexpected ${tag.name} element.`)
    }
    stack.push(f)
  }
  parser.onclosetag = () => {
    const f = stack.pop()!
    if (f.name === 'TRACK' && stack.at(-1)?.name === 'COLLECTION' && current) {
      const ref = reference(current.attrs.Location!)
      try {
        addTrack.run(
          current.key,
          JSON.stringify(current.attrs),
          ref.localPath,
          ref.refKind,
          JSON.stringify(current.tempo),
          JSON.stringify(current.cues)
        )
      } catch {
        throw new Error('Duplicate collection TrackID.')
      }
      current = null
    }
    if (f.id) {
      db.prepare('UPDATE nodes SET entries=? WHERE id=?').run(f.children, f.id)
      if (f.declared !== undefined && f.declared !== f.children)
        throw new Error('Playlist node count does not match its contents.')
    }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const digest = createHash('sha256')
  const buffer = Buffer.alloc(64 * 1024)
  try {
    while (true) {
      const read = await input.read(buffer, 0, buffer.length, null)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      if (bytes > L.bytes) throw new Error('XML exceeds the 256 MiB limit.')
      const chunk = buffer.subarray(0, read.bytesRead)
      digest.update(chunk)
      await output.write(chunk)
      parser.write(decoder.decode(chunk, { stream: true }))
      if (Date.now() - lastProgress > 250) {
        parentPort!.postMessage({ progress: { tracks, bytes } })
        lastProgress = Date.now()
      }
    }
    parser.write(decoder.decode()).close()
    if (!same(await input.stat({ bigint: true })) || BigInt(bytes) !== first.size)
      throw new Error('XML changed while it was being read. Export it again.')
    if (roots !== 1 || collections !== 1 || playlistSections !== 1)
      throw new Error('The export needs COLLECTION and PLAYLISTS sections.')
    if (declaredTracks !== undefined && tracks !== declaredTracks)
      throw new Error('Collection count does not match its contents.')
    if (!products) warn('The XML does not identify its exporting product/version.')
    db.exec(
      "UPDATE memberships SET trackKey=ref WHERE keyType='0' AND EXISTS(SELECT 1 FROM tracks t WHERE t.trackKey=memberships.ref)"
    )
    const byLocation = db.prepare('SELECT trackKey FROM tracks WHERE localPath=?')
    const setKey = db.prepare('UPDATE memberships SET trackKey=? WHERE nodeId=? AND ordinal=?')
    let cursor = 0
    while (true) {
      const batch = db
        .prepare(
          "SELECT rowid AS cursor,* FROM memberships WHERE keyType='1' AND rowid>? ORDER BY rowid LIMIT 1000"
        )
        .all(cursor) as {
        cursor: number
        nodeId: string
        ordinal: number
        ref: string
      }[]
      if (!batch.length) break
      for (const m of batch) {
        cursor = m.cursor
        const ref = reference(m.ref)
        const matches = ref.localPath
          ? (byLocation.all(ref.localPath) as { trackKey: string }[])
          : []
        if (matches.length === 1) setKey.run(matches[0]!.trackKey, m.nodeId, m.ordinal)
      }
    }
    const dangling = (
      db.prepare('SELECT COUNT(*) n FROM memberships WHERE trackKey IS NULL').get() as { n: number }
    ).n
    if (dangling) warn('Some playlist references cannot be resolved uniquely within this snapshot.')
    db.exec('COMMIT')
    await output.sync()
    await chmod(raw, 0o400)
    parentPort!.postMessage({
      result: {
        hash: digest.digest('hex'),
        size: bytes,
        modifiedAt: first.mtime.toISOString(),
        tracks,
        nodes,
        playlists: playlistCount,
        memberships,
        dangling,
        product,
        warnings,
      },
    })
  } finally {
    db.close()
    await input.close()
    await output.close()
  }
}
if (parentPort && workerData)
  run().catch(e =>
    parentPort!.postMessage({
      error: e instanceof Error ? e.message : 'XML could not be read.',
    })
  )

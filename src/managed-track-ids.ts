import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import path from 'node:path'

const MAX_ID = 2147483647
const digest = (file: string) => createHash('sha256').update(path.normalize(file)).digest('hex')
async function read(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!handle) return null
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 96 * 1024 * 1024)
      throw new Error('Managed track ID registry is not an ordinary bounded file.')
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

/** Persistent 31-bit XML IDs, with hashed paths and explicit collision allocation. */
export async function managedTrackIDs(directory: string, files: string[], guard: () => void) {
  const file = path.join(directory, 'managed-track-ids.json')
  const previous = await read(file)
  let parsed: { version: number; ids: Record<string, number> }
  try {
    parsed = previous === null ? { version: 1, ids: {} } : JSON.parse(previous)
  } catch {
    throw new Error('Managed track ID registry is invalid. Preserve it and choose another profile.')
  }
  if (
    !parsed ||
    parsed.version !== 1 ||
    !parsed.ids ||
    typeof parsed.ids !== 'object' ||
    Array.isArray(parsed.ids)
  )
    throw new Error('Managed track ID registry is invalid.')
  const entries = Object.entries(parsed.ids)
  const used = new Set<number>()
  for (const [key, value] of entries) {
    if (
      !/^[0-9a-f]{64}$/.test(key) ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > MAX_ID ||
      used.has(value)
    )
      throw new Error('Managed track ID registry contains invalid or repeated IDs.')
    used.add(value)
  }
  if (entries.length > 1000000 || files.length > 100000)
    throw new Error('Managed track ID registry exceeds the supported limit.')
  let changed = false
  const result = new Map<string, string>()
  for (const original of files.slice().sort()) {
    guard()
    const key = digest(original)
    let value = parsed.ids[key]
    if (!value) {
      if (used.size >= 1000000)
        throw new Error('Managed track ID registry exceeds the supported limit.')
      value = (Number.parseInt(key.slice(0, 8), 16) % MAX_ID) + 1
      while (used.has(value)) value = value === MAX_ID ? 1 : value + 1
      parsed.ids[key] = value
      used.add(value)
      changed = true
    }
    result.set(path.normalize(original), String(value))
  }
  if (changed) {
    const temporary = path.join(directory, `.managed-track-ids-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(parsed), 'utf8')
      await handle.sync()
      await handle.close()
      guard()
      if ((await read(file)) !== previous)
        throw new Error('Managed track ID registry changed during export.')
      guard()
      await rename(temporary, file)
    } finally {
      await handle.close().catch(() => {})
      await rm(temporary, { force: true })
    }
  }
  return result
}

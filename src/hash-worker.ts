import { parentPort, workerData } from 'node:worker_threads'
import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
async function run() {
  const { path, expected } = workerData
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat({ bigint: true })
    if (
      !before.isFile() ||
      String(before.dev) !== expected.device ||
      String(before.ino) !== expected.inode ||
      Number(before.size) !== expected.size
    )
      throw new Error('File identity changed. Run Smart Scan.')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    let position = 0
    while (position < expected.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, expected.size - position),
        position
      )
      if (!bytesRead) throw new Error('File was truncated while checking duplicates.')
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('File changed while checking duplicates.')
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}
run().then(
  hash => parentPort!.postMessage({ hash }),
  error => parentPort!.postMessage({ error: error.message })
)

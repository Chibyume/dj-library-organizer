import { open, type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { AbstractTokenizer, EndOfStreamError, type IReadChunkOptions } from 'strtok3'

// Public tokenizer API: random access from a checked, no-follow file descriptor.
export class CheckedTokenizer extends AbstractTokenizer {
  fileInfo: { path: string; size: number }
  private bytesRead = 0
  private constructor(
    private handle: FileHandle,
    filePath: string,
    size: number
  ) {
    super()
    this.fileInfo = { path: filePath, size }
  }
  static async create(filePath: string, expected: { device: string; inode: string; size: number }) {
    const handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const st = await handle.stat({ bigint: true })
      if (
        !st.isFile() ||
        String(st.dev) !== expected.device ||
        String(st.ino) !== expected.inode ||
        Number(st.size) !== expected.size
      )
        throw new Error('Source identity changed before reading. Retry Smart Scan.')
      return new CheckedTokenizer(handle, filePath, Number(st.size))
    } catch (e) {
      await handle.close()
      throw e
    }
  }
  supportsRandomAccess() {
    return true
  }
  setPosition(position: number) {
    if (!Number.isSafeInteger(position) || position < 0 || position > this.fileInfo.size)
      throw new Error('Invalid metadata offset')
    this.position = position
  }
  async peekBuffer(buffer: Uint8Array, options?: IReadChunkOptions) {
    const normalized = this.normalizeOptions(buffer, options)
    if (
      normalized.length > 16 * 1024 * 1024 ||
      buffer.byteLength > 16 * 1024 * 1024 ||
      this.bytesRead > 64 * 1024 * 1024
    )
      throw new Error('Metadata exceeds the bounded read limit. File left unchanged.')
    if (!Number.isSafeInteger(normalized.position) || normalized.position < 0)
      throw new Error('Invalid metadata position')
    const { bytesRead } = await this.handle.read(buffer, 0, normalized.length, normalized.position)
    this.bytesRead += bytesRead
    if (bytesRead < normalized.length && !normalized.mayBeLess) throw new EndOfStreamError()
    return bytesRead
  }
  async readBuffer(buffer: Uint8Array, options?: IReadChunkOptions) {
    const position = options?.position ?? this.position
    const count = await this.peekBuffer(buffer, options)
    this.position = position + count
    return count
  }
  async close() {
    await this.handle.close()
    await super.close()
  }
}

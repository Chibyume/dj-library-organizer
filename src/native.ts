import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface Inspection {
  regular: boolean
  links: number
  directory: boolean
  package: boolean
  alias: boolean
  cloudOnly: boolean
  availabilityUnknown: boolean
  device: string
  inode: string
  birth: string
  size: number
  mtime: string
  ctime: string
  volume: string | null
}
export class NativeHelper {
  private child: ChildProcessWithoutNullStreams
  private seq = 0
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void
      reject: (e: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  constructor(executable: string) {
    this.child = spawn(executable, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin' },
    })
    createInterface({ input: this.child.stdout }).on('line', line => {
      try {
        const response = JSON.parse(line)
        const p = this.pending.get(response.id)
        if (!p) return
        clearTimeout(p.timer)
        this.pending.delete(response.id)
        response.ok
          ? p.resolve(response.value)
          : p.reject(new Error(response.error || 'Native helper failed'))
      } catch {
        /* Discard malformed helper output; timeout handles outstanding requests. */
      }
    })
    this.child.stderr.on('data', () => {})
    this.child.on('error', error => this.fail(error))
    this.child.on('exit', () => this.fail(new Error('The native helper stopped. Restart the app.')))
  }
  private fail(error: Error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
  }
  call<T = any>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Native helper timed out.'))
      }, 10000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ id, command, ...args }) + '\n')
    })
  }
  inspect(filePath: string) {
    return this.call<Inspection>('inspect', { path: filePath })
  }
  close() {
    this.fail(new Error('App closed'))
    this.child.kill()
  }
}

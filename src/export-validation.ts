import { Worker } from 'node:worker_threads'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type { NativeHelper } from './native'
// Validate generated XML with the same strict, bounded parser used for imports.
export async function validateExportXML(
  xml: string,
  directory: string,
  helper: NativeHelper,
  cancelled: () => boolean
) {
  const temporary = await mkdtemp(path.join(directory, 'export-validation-'))
  try {
    const source = path.join(temporary, 'generated.xml')
    await writeFile(source, xml, { mode: 0o600, flag: 'wx' })
    const expected = await helper.inspect(source)
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'xml-worker.cjs'), {
        workerData: {
          source,
          stage: path.join(temporary, 'stage.sqlite'),
          raw: path.join(temporary, 'raw.xml'),
          expected,
        },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      })
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearInterval(poll)
        clearTimeout(timer)
        void worker.terminate()
        error ? reject(error) : resolve()
      }
      const poll = setInterval(() => {
        if (cancelled()) finish(new Error('Export validation cancelled.'))
      }, 100)
      const timer = setTimeout(() => finish(new Error('Export XML validation timed out.')), 120000)
      worker.on('message', message => {
        if (message.error) finish(new Error(message.error))
        else if (message.result) finish()
      })
      worker.once('error', error =>
        finish(error instanceof Error ? error : new Error('XML validation failed.'))
      )
      worker.once('exit', () => finish(new Error('XML validator stopped.')))
    })
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

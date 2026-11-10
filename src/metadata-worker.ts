import { parentPort } from 'node:worker_threads'
import { parseFromTokenizer, type IAudioMetadata } from 'music-metadata'
import { CheckedTokenizer } from './tokenizer'
import { extractMetadata, readableAudio, describeMetadataError } from './metadata'
parentPort?.on('message', async ({ path, expected }) => {
  let tokenizer: CheckedTokenizer | undefined
  let observed: IAudioMetadata | undefined
  try {
    tokenizer = await CheckedTokenizer.create(path, expected)
    const m = await parseFromTokenizer(tokenizer, {
      skipCovers: true,
      duration: false,
      observer: event => {
        observed = event.metadata
      },
    })
    if (!readableAudio(m))
      throw new Error(
        'Unsupported or corrupt audio: no recognized audio stream could be read. A missing sample rate alone is not an error.'
      )
    parentPort?.postMessage({ ok: true, value: extractMetadata(m) })
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: describeMetadataError(
        error instanceof Error ? error.message : 'Cannot parse this audio file'
      ),
      partial: observed ? extractMetadata(observed, true) : undefined,
    })
  } finally {
    await tokenizer?.close()
  }
})

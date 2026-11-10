import path from 'node:path'
import { unlink, readdir } from 'node:fs/promises'

// Remove only files owned by the retired integration. Never read or decrypt them.
export async function removeRetiredResearchKey(profile: string) {
  const files = await readdir(profile)
  for (const name of files) {
    if (
      name !== 'research-key.encrypted' &&
      !/^research-key-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/.test(name)
    )
      continue
    try {
      await unlink(path.join(profile, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

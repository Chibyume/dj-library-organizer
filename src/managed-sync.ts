import path from 'node:path'
import { mkdir, readFile, open, rename, rm, lstat, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import type { NativeHelper } from './native'
export const SYNC_NAMESPACE = 'DJ Library Organizer'
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const GUIDE = `DJ Library Organizer — practice and prepared playlists

Point rekordbox's imported XML library at this folder's rekordbox.xml once (Preferences > Advanced > Database in rekordbox 7; enable rekordbox xml in the tree). Refresh the XML tree after the organizer updates it, then import the DJ Library Organizer folder/playlists using the context menu.

This file updates automatically while the organizer is open. It does not directly update rekordbox's Collection. Check replacement/merge prompts before importing again: rekordbox may retain old playlist memberships. Existing Collection entries, missing references, and native playlists are not deleted by the organizer.

Practice Library mirrors the organizer's available practice tracks: All Practice Tracks, every current local genre label (a song can be in several genres), Unsorted, and My Playlists with your folders. Held classifications remain available here. Files that are missing, changed, outside enabled source access or otherwise fail fresh local validation are omitted until rescanned/recovered. Repeated catalogue entries at one path are never exported twice.

Prepared playlists is the separate stricter collection: only ready approved classifications and preferred copies are included. Duplicate-check or approval problems can leave this branch empty while Practice Library still updates. The organizer shows separate practice/prepared counts and any preparation issue.

Local genre tags determine playlist membership; they do not replace Rekordbox's Genre column or My Tags. Audio files and embedded tags stay untouched. Cue/grid metadata is reused only for a prepared track with a single conflict-free exact-path reference; no preparation is inferred for held practice entries.

To refresh reference information in the organizer, export your collection from rekordbox to the same XML path previously imported into the organizer. Enable Watch my exported Rekordbox XML in Automatic downloads & sync. This output file and that incoming collection export are separate files.

rekordbox.previous.xml is the immediately preceding generated playlist library. Do not edit generated files. Create personal playlists in the organizer if you want them included here, or independently in Rekordbox.

Official format and import workflow: https://rekordbox.com/en/support/developer/
`
export class ManagedSync {
  private owner: string
  constructor(
    private profile: string,
    private helper: NativeHelper
  ) {
    this.owner = sha256(profile)
  }
  private async ordinary(directory: string) {
    if ((await realpath(directory)) !== directory)
      throw new Error('Sync folder moved or became a link. Choose it again.')
    const info = await this.helper.inspect(directory)
    if (!info.directory || info.alias || info.package || info.cloudOnly || info.availabilityUnknown)
      throw new Error('Choose a locally available ordinary sync folder.')
  }
  async choose(parent: string) {
    await this.ordinary(parent)
    const directory = path.join(parent, 'DJ Library Organizer Sync')
    let created = false
    try {
      await mkdir(directory, { mode: 0o700 })
      created = true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    if (created) {
      await this.atomic(directory, '.organizer-owner', this.owner, () => {})
      await this.atomic(directory, 'READ ME.txt', GUIDE, () => {})
    }
    await this.validate(directory)
    return directory
  }
  async validate(directory: string) {
    await this.ordinary(directory)
    const marker = await lstat(path.join(directory, '.organizer-owner'))
    if (
      !marker.isFile() ||
      marker.isSymbolicLink() ||
      marker.size > 100 ||
      (await readFile(path.join(directory, '.organizer-owner'), 'utf8')) !== this.owner
    )
      throw new Error(
        'This folder is not owned by this organizer profile. Choose another parent folder.'
      )
  }
  private async readXML(directory: string): Promise<string | null> {
    const file = path.join(directory, 'rekordbox.xml')
    const st = await lstat(file).catch(e => {
      if (e.code === 'ENOENT') return null
      throw e
    })
    if (!st) return null
    if (!st.isFile() || st.isSymbolicLink() || st.size > 128 * 1024 * 1024)
      throw new Error('Sync XML is not an ordinary generated file.')
    return readFile(file, 'utf8')
  }
  async verify(directory: string, expected: string) {
    await this.validate(directory)
    const xml = await this.readXML(directory)
    if (xml === null || sha256(xml) !== expected)
      throw new Error(
        'Generated sync XML is missing or changed. Choose a new sync folder to preserve external changes.'
      )
  }
  private async atomic(directory: string, name: string, text: string, guard: () => void) {
    const temp = path.join(directory, `.${name}.${randomUUID()}.tmp`)
    const handle = await open(temp, 'wx', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
      await handle.close()
      guard()
      await rename(temp, path.join(directory, name))
    } finally {
      await handle.close().catch(() => {})
      await rm(temp, { force: true })
    }
  }
  async publish(directory: string, xml: string, previousHash: string | null, guard: () => void) {
    await this.validate(directory)
    const previous = await this.readXML(directory)
    const hash = sha256(xml)
    if (previous === xml) {
      await this.atomic(directory, 'READ ME.txt', GUIDE, guard)
      return { hash, changed: false }
    }
    if (previous !== null && (!previousHash || sha256(previous) !== previousHash))
      throw new Error(
        'The sync XML was changed outside the organizer. Choose a new sync folder to preserve that file.'
      )
    if (previous !== null) await this.atomic(directory, 'rekordbox.previous.xml', previous, guard)
    await this.atomic(directory, 'READ ME.txt', GUIDE, guard)
    // Recheck ownership and content immediately before publishing the single atomic XML.
    await this.validate(directory)
    if ((await this.readXML(directory)) !== previous)
      throw new Error('Sync XML changed during preparation; nothing published.')
    await this.atomic(directory, 'rekordbox.xml', xml, guard)
    return { hash, changed: true }
  }
}

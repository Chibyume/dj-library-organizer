import path from 'node:path'
import { readdir, realpath } from 'node:fs/promises'
import type { LibraryDB } from './db'
import type { NativeHelper } from './native'
import {
  AUDIO_EXTENSIONS,
  EXCLUDED,
  SYSTEM_DIRECTORIES,
  TEMP,
  PACKAGE,
  physicalKey,
  stablePhysicalKey,
  signature,
  within,
  type Scanner,
} from './scanner'
import type { Classifier } from './classifier'
import type { DuplicateHashes } from './duplicate-hashes'
import type { Preparation } from './preparation'
import type { Rekordbox } from './rekordbox'
import type { Source } from './shared'
import type { AutomationOptions, AutomationState } from './automation-types'
import { ManagedSync, sha256 } from './managed-sync'
import { Organization } from './organization'

export class SettledFiles {
  private files = new Map<string, { stamp: string; since: number }>()
  observe(file: string, stamp: string, now: number, delay = 20000) {
    const previous = this.files.get(file)
    if (!previous || previous.stamp !== stamp) {
      this.files.set(file, { stamp, since: now })
      return false
    }
    return now - previous.since >= delay
  }
  retain(paths: Set<string>) {
    for (const file of this.files.keys()) if (!paths.has(file)) this.files.delete(file)
  }
  clear() {
    this.files.clear()
  }
}
const defaults: AutomationState = {
  config: {
    enabled: false,
    sourceIds: [],
    autoApprove: true,
    syncEnabled: false,
    watchRekordbox: false,
    syncDirectory: null,
    rekordboxPath: null,
  },
  active: false,
  running: false,
  phase: 'Paused',
  pending: 0,
  lastCheckedAt: null,
  lastCompletedAt: null,
  error: null,
  sync: null,
}
export class Automation {
  private value: AutomationState
  private timer: ReturnType<typeof setInterval> | null = null
  private task: Promise<void> | null = null
  private stopped = true
  private generation = 0
  private settled = new SettledFiles()
  private incoming = new SettledFiles()
  private lastInput = ''
  private xmlStamp = ''
  private organization: Organization
  readonly output: ManagedSync
  constructor(
    private db: LibraryDB,
    private helper: NativeHelper,
    private scanner: Scanner,
    private classifier: Classifier,
    private hashes: DuplicateHashes,
    private preparation: Preparation,
    private rekordbox: Rekordbox,
    private busy: () => boolean,
    private notify: () => void,
    private version: string,
    private excludedRoots: string[] = []
  ) {
    const row = db.db.prepare('SELECT data FROM automation_state WHERE id=1').get() as
      { data: string } | undefined
    this.value = row
      ? {
          ...JSON.parse(row.data),
          active: false,
          running: false,
          phase: 'Paused until app startup',
        }
      : structuredClone(defaults)
    this.output = new ManagedSync(db.directory, helper)
    this.organization = new Organization(db)
  }
  get running() {
    return this.task !== null
  }
  state(): AutomationState {
    return structuredClone(this.value)
  }
  private emit() {
    this.db.db
      .prepare(
        'INSERT INTO automation_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data'
      )
      .run(JSON.stringify(this.value))
    this.notify()
  }
  private phase(text: string) {
    this.value.phase = text
    this.emit()
  }
  configure(options: AutomationOptions) {
    if (this.running && options.enabled)
      throw new Error('Pause automatic handling before changing its settings.')
    const sources = this.db.sources()
    if (options.sourceIds.some(id => !sources.some(s => s.id === id && !s.broad)))
      throw new Error(
        'Choose existing specific source folders; broad home-folder monitoring is excluded.'
      )
    if (options.syncEnabled && !this.value.config.syncDirectory)
      throw new Error('Choose the sync output folder first.')
    let incoming = this.value.config.rekordboxPath
    if (options.watchRekordbox && options.enabled) {
      const active = this.db.db
        .prepare('SELECT sourcePath,product FROM rb_snapshots WHERE active=1')
        .get() as { sourcePath: string; product: string } | undefined
      if (!active || !/^rekordbox(?:\s|$)/i.test(active.product))
        throw new Error('Import an XML exported by rekordbox first.')
      incoming = active.sourcePath
    }
    if (
      incoming &&
      this.value.config.syncDirectory &&
      within(this.value.config.syncDirectory, incoming)
    )
      throw new Error('Incoming collection XML must be separate from the generated sync output.')
    this.xmlStamp = ''
    this.value.config = {
      ...this.value.config,
      ...options,
      rekordboxPath: incoming,
    }
    this.lastInput = ''
    this.settled.clear()
    this.incoming.clear()
    if (options.enabled) this.start()
    else this.pause()
    this.emit()
    return this.state()
  }
  async folder(parent: string) {
    if (this.running) throw new Error('Pause automatic handling before changing the sync folder.')
    if (this.db.sources().some(s => within(s.path, parent)))
      throw new Error('Choose a sync output folder outside your audio source folders.')
    const directory = await this.output.choose(parent)
    if (directory !== this.value.config.syncDirectory) this.value.sync = null
    this.value.config.syncDirectory = directory
    this.lastInput = ''
    this.emit()
    return this.state()
  }
  start() {
    if (!this.value.config.enabled) return
    this.stopped = false
    this.value.active = true
    if (!this.timer)
      this.timer = setInterval(() => {
        void this.check()
      }, 30000)
    this.phase('Watching selected folders')
    void this.check()
  }
  pause() {
    this.stopped = true
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.value.active = false
    if (this.running) {
      this.scanner.cancel()
      this.hashes.pause()
      this.preparation.cancel()
      this.rekordbox.cancel()
    }
    this.phase(this.running ? 'Pausing…' : 'Paused')
  }
  async close() {
    this.pause()
    await this.task
    await this.organization.close()
  }
  private guard(generation: number) {
    if (this.stopped || generation !== this.generation)
      throw new Error('Automatic handling paused.')
  }
  private input() {
    return sha256(
      JSON.stringify([
        'practice-library-v1',
        this.db.db
          .prepare(
            'SELECT id,signature,path,category,review,revision,availability,title,artist,genre,year,bpm,key,duration FROM files ORDER BY id'
          )
          .all(),
        this.db.db.prepare('SELECT id,enabled,status FROM sources ORDER BY id').all(),
        this.db.db.prepare('SELECT * FROM duplicate_decisions ORDER BY groupKey').all(),
        this.db.db.prepare('SELECT * FROM playlist_approvals ORDER BY fileId').all(),
        this.db.db.prepare('SELECT id,hash,matchedAt FROM rb_snapshots WHERE active=1').all(),
        this.db.db.prepare('SELECT * FROM classification_settings').all(),
        this.db.db
          .prepare(
            'SELECT fileId,groupName,value,origin FROM organization_tags ORDER BY fileId,groupName,value'
          )
          .all(),
        this.db.db.prepare('SELECT id,parentId,name,kind FROM library_playlists ORDER BY id').all(),
        this.db.db
          .prepare(
            'SELECT playlistId,fileId,ordinal FROM library_playlist_members ORDER BY playlistId,ordinal,fileId'
          )
          .all(),
        this.db.db.prepare('SELECT fileId FROM organization_queue ORDER BY fileId').all(),
      ])
    )
  }
  async check(now = Date.now()) {
    if (this.stopped || !this.value.config.enabled || this.task) return
    if (this.busy()) {
      this.phase('Waiting for the current library operation')
      return
    }
    const generation = this.generation
    this.task = this.run(now, generation)
      .catch(e => {
        if (!this.stopped) {
          this.value.error = e instanceof Error ? e.message : String(e)
          this.value.phase = 'Needs attention — will check again'
        }
      })
      .finally(() => {
        this.task = null
        this.value.running = false
        if (this.stopped) this.value.phase = 'Paused'
        this.emit()
      })
    await this.task
  }
  private async arrivals(now: number, generation: number) {
    if (
      (
        this.db.db.prepare('SELECT COUNT(*) n FROM files').get() as {
          n: number
        }
      ).n > 100000
    )
      throw new Error(
        'Automatic handling supports up to 100,000 catalog files. Reduce the catalog scope.'
      )
    const pending = new Set<string>()
    const ready: { source: Source; path: string; stamp: string }[] = []
    const known = new Map(
      (
        this.db.db.prepare('SELECT path,signature,physicalKey FROM files').all() as {
          path: string
          signature: string
          physicalKey: string
        }[]
      ).map(f => [f.path, `${f.physicalKey}|${f.signature}`])
    )
    const hiddenPhysicalKeys = new Set(
      (
        this.db.db
          .prepare("SELECT physicalKey FROM files WHERE availability IN ('trashed','removed')")
          .all() as { physicalKey: string }[]
      ).map(file => stablePhysicalKey(file.physicalKey))
    )
    const visited = new Set<string>()
    const sources = this.db
      .sources()
      .filter(s => s.enabled && !s.broad && this.value.config.sourceIds.includes(s.id))
    let count = 0
    for (const source of sources) {
      const dirs = [source.path]
      while (dirs.length) {
        this.guard(generation)
        const dir = dirs.pop()!
        if (visited.has(dir) || this.excludedRoots.some(root => within(root, dir))) continue
        if ((await realpath(dir)) !== dir || !within(source.path, dir)) continue
        const info = await this.helper.inspect(dir)
        if (
          !info.directory ||
          info.alias ||
          info.package ||
          info.cloudOnly ||
          info.availabilityUnknown
        )
          continue
        visited.add(dir)
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          this.guard(generation)
          if (++count > 100000)
            throw new Error(
              'Automatic handling reached 100,000 entries. Select smaller source folders.'
            )
          if (count % 100 === 0) await new Promise<void>(r => setImmediate(r))
          if (entry.isSymbolicLink() || entry.name.startsWith('.') || TEMP.test(entry.name))
            continue
          const file = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (
              !EXCLUDED.has(entry.name.toLowerCase()) &&
              !PACKAGE.test(entry.name) &&
              !SYSTEM_DIRECTORIES.has(file.toLowerCase())
            )
              dirs.push(file)
          } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase())) {
            const info = await this.helper.inspect(file).catch(() => null)
            if (
              !info ||
              !info.regular ||
              info.alias ||
              info.cloudOnly ||
              info.availabilityUnknown ||
              info.size === 0
            )
              continue
            const key = physicalKey(info)
            if (hiddenPhysicalKeys.has(stablePhysicalKey(key))) continue
            const observed = this.db.resolvePhysical(key, file)
            if (observed && ['trashed', 'removed'].includes(observed.availability)) continue
            const stamp = `${key}|${signature(info)}`
            if (known.get(file) === stamp) continue
            pending.add(file)
            if (this.settled.observe(file, stamp, now) && ready.length < 50)
              ready.push({ source, path: file, stamp })
          }
        }
      }
    }
    this.settled.retain(pending)
    this.value.pending = pending.size
    return ready
  }
  private async refreshXML(now: number, generation: number) {
    const file = this.value.config.rekordboxPath
    if (!this.value.config.watchRekordbox || !file) return false
    const info = await this.helper.inspect(file)
    if (!info.regular || info.alias || info.cloudOnly || info.availabilityUnknown)
      throw new Error('Watched Rekordbox XML is unavailable. Export it again to the same path.')
    const stamp = `${physicalKey(info)}|${signature(info)}`
    if (stamp === this.xmlStamp || !this.incoming.observe(file, stamp, now)) return false
    this.phase('Refreshing the exported Rekordbox collection')
    const candidates = await this.rekordbox.find([file])
    this.guard(generation)
    const candidate = candidates.candidates.find(
      c => c.valid && c.path === file && /^rekordbox(?:\s|$)/i.test(c.product)
    )
    if (!candidate)
      throw new Error(
        'Watched XML is not a valid collection exported by rekordbox. The previous snapshot is retained.'
      )
    await this.rekordbox.import(candidate.id, true)
    this.guard(generation)
    this.xmlStamp = stamp
    return true
  }
  private async run(now: number, generation: number) {
    this.value.running = true
    this.value.error = null
    this.phase('Checking for finished downloads')
    const ready = await this.arrivals(now, generation)
    const refreshed = await this.refreshXML(now, generation)
    this.guard(generation)
    if (ready.length) {
      this.phase(`Reading ${ready.length} finished downloads`)
      this.scanner.startArrivals(ready)
      await this.scanner.wait()
      this.guard(generation)
      if (this.scanner.progress?.status !== 'completed')
        throw new Error('Automatic file inspection did not finish. Check scan details.')
      this.value.pending = Math.max(
        0,
        this.value.pending -
          (this.scanner.progress.newFiles +
            this.scanner.progress.changed +
            this.scanner.progress.unchanged)
      )
      await this.rekordbox.reconcile()
      this.guard(generation)
    }
    this.value.lastCheckedAt = new Date(now).toISOString()
    if (ready.length || refreshed || this.input() !== this.lastInput) {
      this.phase('Classifying and checking preferred copies')
      this.classifier.runNow()
      await this.classifier.wait()
      this.guard(generation)
      await this.organization.organize()
      this.guard(generation)
      let preparedIssue: string | null = null
      try {
        this.hashes.start()
        await this.hashes.wait()
        this.guard(generation)
        if (this.hashes.state()?.status !== 'completed')
          throw new Error('Duplicate check did not finish. Check preparation details.')
        await this.preparation.autoChoose()
      } catch (error) {
        this.guard(generation)
        // Practice membership is independent of strict duplicate/approval eligibility.
        preparedIssue = error instanceof Error ? error.message : String(error)
      }
      this.guard(generation)
      const directory = this.value.config.syncDirectory
      if (this.value.config.syncEnabled && directory) {
        this.phase('Updating the Rekordbox XML playlists')
        let published: { hash: string; changed: boolean } | undefined
        const result = await this.preparation.sync(
          this.value.config.autoApprove,
          this.version,
          async (xml, guard) => {
            this.guard(generation)
            published = await this.output.publish(
              directory,
              xml,
              this.value.sync?.hash || null,
              () => {
                this.guard(generation)
                guard()
              }
            )
          },
          preparedIssue
        )
        this.value.sync = {
          ...result,
          hash: published!.hash,
          xmlPath: path.join(directory, 'rekordbox.xml'),
          updatedAt: published!.changed
            ? new Date().toISOString()
            : this.value.sync?.updatedAt || new Date().toISOString(),
        }
      }
      this.lastInput = this.input()
      this.value.lastCompletedAt = new Date().toISOString()
    }
    if (this.value.config.syncEnabled && this.value.sync && this.value.config.syncDirectory)
      await this.output.verify(this.value.config.syncDirectory, this.value.sync.hash)
    this.phase(
      this.value.sync?.preparedIssue
        ? 'Practice playlists updated; prepared playlists need attention'
        : this.value.pending
          ? `Waiting for ${this.value.pending} download(s) to settle`
          : 'Watching selected folders'
    )
  }
}

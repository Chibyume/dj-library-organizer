import { Organization } from './organization'
import { TrackTrash } from './track-trash'
import { TrashLibrary } from './trash-library'
import { Automation } from './automation'
import path from 'node:path'
import { LibraryDB } from './db'
import { NativeHelper } from './native'
import { Scanner } from './scanner'
import { Rekordbox } from './rekordbox'
import { syntheticResearch } from './research-fixture'
import { Researcher } from './research'
import { ResearchImporter } from './research-import'
import { DuplicateHashes } from './duplicate-hashes'
import { DuplicateCleanup } from './duplicate-cleanup'
import { Preparation } from './preparation'
import { Classifier } from './classifier'

const port = (process as any).parentPort
const profile = process.argv[2]!
const nativePath = process.argv[3]!
const db = new LibraryDB(profile)
const helper = new NativeHelper(nativePath)
const organization = new Organization(db)
let organizationTimer: ReturnType<typeof setTimeout> | undefined
let organizationClosing = false
function scheduleOrganization() {
  if (organizationClosing || organizationTimer) return
  organizationTimer = setTimeout(async () => {
    organizationTimer = undefined
    if (organizationClosing) return
    if (
      scanner.running ||
      classifier.running ||
      cleanup.running ||
      trash.running ||
      trashLibrary.running ||
      rekordbox.running ||
      automation.running ||
      preparation.running
    ) {
      scheduleOrganization()
      return
    }
    try {
      const result = await organization.organize()
      if (result.processed || result.changed) port.postMessage({ event: { kind: 'organization' } })
      if (result.pending) scheduleOrganization()
    } catch {
      /* Keep pending metadata queued for the next pass. */
    }
  }, 400)
}

const scanner = new Scanner(
  db,
  helper,
  path.join(__dirname, 'metadata-worker.cjs'),
  progress => {
    port.postMessage({ event: { kind: 'scan', progress } })
    if (progress.status !== 'running') scheduleOrganization()
    if (progress.status !== 'running' && !progress.incremental)
      void rekordbox
        .reconcile()
        .catch(() => {})
        .finally(() => {
          classifier.schedule()
          scheduleOrganization()
        })
  },
  [profile, path.dirname(nativePath)]
)
const rekordbox = new Rekordbox(db, helper, path.join(__dirname, 'xml-worker.cjs'), xmlProgress =>
  port.postMessage({ event: { kind: 'xml', xmlProgress } })
)
const classifier = new Classifier(db, classificationProgress => {
  port.postMessage({
    event: { kind: 'classification', classificationProgress },
  })
  if (classificationProgress.status !== 'running') scheduleOrganization()
})
const researcher = new Researcher(
  db,
  classifier,
  () => {
    port.postMessage({ event: { kind: 'research' } })
    scheduleOrganization()
  },
  process.argv[4] === 'synthetic-research' ? { musicbrainz: syntheticResearch } : undefined
)
const researchImporter = new ResearchImporter(db, classifier, () =>
  port.postMessage({ event: { kind: 'research' } })
)
const hashes = new DuplicateHashes(db, helper, path.join(__dirname, 'hash-worker.cjs'), () =>
  port.postMessage({ event: { kind: 'duplicate-progress' } })
)
const preparation = new Preparation(
  db,
  helper,
  hashes,
  () => port.postMessage({ event: { kind: 'preparation' } }),
  classifier
)
const cleanup = new DuplicateCleanup(db, helper, hashes, preparation, () => {
  port.postMessage({ event: { kind: 'library' } })
  if (!cleanup.running) {
    classifier.schedule()
    scheduleOrganization()
  }
})
const trash = new TrackTrash(db, helper, () => {
  port.postMessage({ event: { kind: 'library' } })
  if (!trash.running) {
    classifier.schedule()
    scheduleOrganization()
  }
})
const trashLibrary = new TrashLibrary(db, helper, trash, cleanup)
const automation = new Automation(
  db,
  helper,
  scanner,
  classifier,
  hashes,
  preparation,
  rekordbox,
  () =>
    scanner.running ||
    classifier.running ||
    hashes.running ||
    preparation.running ||
    rekordbox.running ||
    cleanup.running ||
    trash.running ||
    trashLibrary.running ||
    organization.running ||
    researcher.running,
  () => port.postMessage({ event: { kind: 'automation' } }),
  process.argv[5] || 'development',
  [profile, path.dirname(nativePath)]
)
const automationReads = new Set([
  'organizationState',
  'organizationTrack',
  'libraryReviewOverview',
  'trackTrashHistory',

  'automationState',
  'automationConfigure',
  'automationCheck',
  'automationStart',
  'summary',
  'sources',
  'list',
  'get',
  'inspect',
  'previewEvidence',
  'xmlSummary',
  'xmlList',
  'xmlTrack',
  'classificationState',
  'classificationTrack',
  'classificationRules',
  'researchState',
  'researchTrack',
  'duplicateState',
  'cleanupState',
  'cleanupHistory',
  'preparationHistory',
])
function idleForPreparation() {
  if (organization.running) throw new Error('Local tags are updating. Try again shortly.')
  if (scanner.running || rekordbox.running)
    throw new Error('Finish the scan or XML operation before preparing playlists.')
}
port.on('message', async ({ data: message }: any) => {
  const { id, method, args } = message
  try {
    let value: unknown
    if (
      (trash.running || trashLibrary.running) &&
      ![
        'summary',
        'sources',
        'list',
        'get',
        'organizationState',
        'organizationTrack',
        'libraryReviewOverview',
        'trackTrashHistory',
        'classificationState',
        'shutdown',
      ].includes(method)
    )
      throw new Error('Wait for Move to Trash or restore to finish before changing the library.')

    if (
      cleanup.running &&
      ![
        'cleanupState',
        'organizationState',
        'organizationTrack',
        'libraryReviewOverview',
        'trackTrashHistory',
        'cleanupHistory',
        'cleanupPause',
        'summary',
        'sources',
        'list',
        'get',
        'classificationState',
        'duplicateState',
        'preparationHistory',
        'shutdown',
      ].includes(method)
    )
      throw new Error('Wait for cleanup or pause it before changing the library.')
    if (automation.running && method !== 'shutdown' && !automationReads.has(method))
      throw new Error(
        'Automatic handling is updating the library. Pause it in Automatic downloads & sync, or try again shortly.'
      )
    switch (method) {
      case 'organizationState':
        value = organization.state()
        break
      case 'organizationTrack':
        value = organization.track(args)
        break
      case 'organizationRun':
        idleForPreparation()
        if (classifier.running || cleanup.running || trash.running)
          throw new Error('Wait for the current library update to finish.')
        value = await organization.organize()
        port.postMessage({ event: { kind: 'organization' } })
        break
      case 'organizationTagsUpdate':
        organization.tagsUpdate(args)
        classifier.schedule()
        scheduleOrganization()
        port.postMessage({ event: { kind: 'library' } })
        break
      case 'organizationFamiliarity':
        organization.familiarity(args)
        port.postMessage({ event: { kind: 'library' } })
        break
      case 'playlistCreate':
        value = organization.playlistCreate(args)
        port.postMessage({ event: { kind: 'organization' } })
        break
      case 'playlistRename':
        organization.playlistRename(args)
        port.postMessage({ event: { kind: 'organization' } })
        break
      case 'playlistDelete':
        organization.playlistDelete(args)
        port.postMessage({ event: { kind: 'organization' } })
        break
      case 'playlistMembers':
        organization.playlistMembers(args)
        port.postMessage({ event: { kind: 'organization' } })
        break
      case 'playlistExportData': {
        idleForPreparation()
        if (classifier.running || automation.running || hashes.running || preparation.running)
          throw new Error('Finish the current library update before exporting a playlist.')
        const exportEpoch = () =>
          `${(db.db.prepare('SELECT total_changes() n').get() as { n: number }).n}:${db.db.pragma('data_version', { simple: true })}`
        const startingEpoch = exportEpoch()
        const query = typeof args === 'string' ? { view: 'playlist' as const, value: args } : args
        const playlist =
          query.view === 'playlist'
            ? organization.state().playlists.find(p => p.id === query.value)
            : null
        if (query.view === 'playlist' && !playlist) throw new Error('Playlist not found.')
        const tracks = []
        let offset = 0
        for (;;) {
          const page = db.list({
            ...query,
            search: '',
            sort: 'title',
            direction: 'asc',
            offset,
            limit: 1000,
          })
          tracks.push(...page.tracks)
          offset += page.tracks.length
          if (offset >= page.total) break
          if (offset >= 100000) throw new Error('Export a smaller playlist.')
          await new Promise(resolve => setImmediate(resolve))
        }
        if (exportEpoch() !== startingEpoch)
          throw new Error(
            'The library or playlist changed while exporting. Try again with the refreshed selection.'
          )
        const available = tracks.filter(t => t.availability === 'available')
        if (!available.length) throw new Error('This playlist has no available files to export.')
        if (available.some(t => /[\r\n\0]/.test(t.path)))
          throw new Error('A filename contains a line break and cannot be exported.')
        const body =
          '#EXTM3U\n' +
          available
            .map(
              t =>
                `#EXTINF:${t.duration === null ? -1 : Math.round(t.duration)},${`${t.artist || ''} - ${t.title || t.filename}`.replace(/[\r\n]/g, ' ')}\n${t.path}`
            )
            .join('\n') +
          '\n'
        if (Buffer.byteLength(body) > 128 * 1024 * 1024)
          throw new Error('Export a smaller playlist.')
        const name =
          playlist?.name ||
          (query.view === 'tag' ? query.value?.split(':').slice(1).join(':') : query.value) ||
          'All Practice Tracks'
        value = {
          name,
          body,
          tracks: available.length,
          unavailable: tracks.length - available.length,
        }
        break
      }
      case 'libraryReviewOverview':
        value = await preparation.reviewOverview()
        break
      case 'trackTrashPreview':
      case 'trackTrashPreviewJunk':
        idleForPreparation()
        if (classifier.running || hashes.running || preparation.running || researcher.running)
          throw new Error('Finish the current library job before moving files to Trash.')
        value =
          method === 'trackTrashPreviewJunk' ? await trash.previewJunk() : await trash.preview(args)
        break
      case 'trackTrashStart':
        idleForPreparation()
        if (classifier.running || hashes.running || preparation.running || researcher.running)
          throw new Error('Finish the current library job before moving files to Trash.')
        value = await trash.start(args)
        classifier.schedule()
        scheduleOrganization()
        break
      case 'trashRestoreFiles':
        idleForPreparation()
        if (classifier.running || hashes.running || preparation.running || researcher.running)
          throw new Error('Finish the current library job before restoring files.')
        value = await trashLibrary.restoreSelected(args)
        classifier.schedule()
        scheduleOrganization()
        port.postMessage({ event: { kind: 'library' } })
        break
      case 'trackTrashHistory':
        value = trash.history()
        break
      case 'trackTrashRestore':
        idleForPreparation()
        if (classifier.running || hashes.running || preparation.running || researcher.running)
          throw new Error('Finish the current library job before restoring files.')
        value = await trash.restore(args)
        classifier.schedule()
        scheduleOrganization()
        break

      case 'automationState':
        value = automation.state()
        break
      case 'automationConfigure':
        value = automation.configure(args)
        break
      case 'automationFolder':
        value = await automation.folder(args)
        break
      case 'automationStart':
        automation.start()
        break
      case 'automationCheck':
        void automation.check()
        break

      case 'duplicateAutoChoose':
        idleForPreparation()
        value = await preparation.autoChoose(args?.replaceExisting === true)
        break
      case 'cleanupPreview':
        idleForPreparation()
        value = await cleanup.preview(args?.includeReferenced === true)
        break
      case 'cleanupStart':
        idleForPreparation()
        await cleanup.start(args)
        break
      case 'cleanupState':
        value = cleanup.state()
        break
      case 'cleanupHistory':
        value = cleanup.history()
        break
      case 'cleanupPause':
        cleanup.pause()
        break
      case 'cleanupRestore':
        idleForPreparation()
        await cleanup.restore(args)
        break
      case 'duplicateMembers':
        value = await preparation.duplicateMembers(args.key, args.fingerprint, args.offset)
        break
      case 'duplicateState':
        value = hashes.state()
        break
      case 'duplicateRun':
        idleForPreparation()
        if (preparation.running) throw new Error('Finish playlist preparation first.')
        hashes.start()
        break
      case 'duplicatePause':
        hashes.pause()
        break
      case 'duplicateList':
        value = await preparation.duplicates(args)
        break
      case 'duplicateResolve':
        idleForPreparation()
        await preparation.resolve(args.key, args.fingerprint, args.keeper)
        break
      case 'preparationPreview':
        idleForPreparation()
        value = await preparation.preview(args)
        break
      case 'preparationPage':
        value = preparation.page(args.token, args.offset, args.filter, args.reason)
        break
      case 'preparationClassify':
        idleForPreparation()
        value = await preparation.classify(args.token, args.ids, args.category)
        break
      case 'preparationApprove':
        idleForPreparation()
        await preparation.approve(args)
        break
      case 'preparationCancel':
        preparation.cancel()
        break
      case 'preparationExport':
        idleForPreparation()
        value = await preparation.export(args.token, args.parent, args.version)
        break
      case 'preparationHistory':
        value = preparation.history()
        break
      case 'preparationVerify':
        idleForPreparation()
        value = await preparation.verify(args)
        break
      case 'preparationImported':
        preparation.reportImported(args)
        break
      case 'summary':
        value = {
          ...db.summary(),
          review: (await preparation.reviewOverview()).total,
        }
        break
      case 'sources':
        value = db.sources()
        break
      case 'list':
        value =
          args.view === 'trash'
            ? trashLibrary.list(args)
            : args.view === 'review'
              ? await preparation.reviewList(args)
              : db.list(args)
        break
      case 'get':
        value = db.get(args)
        break
      case 'addSource':
        value = db.addSource(args.path, args.demo, args.broad)
        break
      case 'scan':
        if (hashes.running || preparation.running)
          throw new Error('Finish or pause playlist preparation before scanning.')
        if (rekordbox.running)
          throw new Error('Finish or cancel the XML operation before starting a scan.')
        value = scanner.start(args.kind, args.sources)
        break
      case 'cancelScan':
        scanner.cancel()
        value = null
        break
      case 'sourceEnabled':
        if (hashes.running || preparation.running)
          throw new Error('Finish or pause playlist preparation before changing sources.')
        if (scanner.running)
          throw new Error('Finish or cancel the scan before changing source access.')
        db.sourceEnabled(args.id, args.enabled)
        port.postMessage({ event: { kind: 'sources' } })
        break
      case 'xmlFind':
        value = await rekordbox.find(args)
        break
      case 'xmlImport':
        if (hashes.running || preparation.running)
          throw new Error('Finish or pause playlist preparation before importing XML.')
        if (scanner.running)
          throw new Error('Finish or cancel the audio scan before importing this snapshot.')
        value = await rekordbox.import(args)
        classifier.schedule()
        scheduleOrganization()
        break
      case 'xmlCancel':
        rekordbox.cancel()
        break
      case 'xmlSummary':
        value = rekordbox.summary()
        break
      case 'xmlList':
        value = rekordbox.list(args)
        break
      case 'xmlTrack':
        value = rekordbox.track(args)
        break
      case 'previewEvidence':
        db.previewEvidence(args.id, args.status, args.error)
        port.postMessage({ event: { kind: 'preview' } })
        break
      case 'classify':
        db.updateDecision(args.changes, 'category', args.category)
        if (classifier.state().automatic) classifier.start()
        scheduleOrganization()
        port.postMessage({ event: { kind: 'library' } })
        value = null
        break
      case 'researchImportFile':
        idleForPreparation()
        if (researcher.running) throw new Error('Pause online research before importing a file.')
        value = await researchImporter.choose(args)
        break
      case 'researchImportApply':
        idleForPreparation()
        if (researcher.running || preparation.running)
          throw new Error('Finish the current research or preparation job first.')
        value = researchImporter.apply(args)
        scheduleOrganization()
        break
      case 'researchState':
        value = researcher.state()
        break
      case 'researchPreview':
        value = researcher.preview(args)
        break
      case 'researchStart':
        researcher.start(args)
        break
      case 'researchPause':
        researcher.pause()
        break
      case 'researchTrack':
        value = researcher.track(args)
        break
      case 'researchAccept':
        researcher.accept(args)
        scheduleOrganization()
        break
      case 'researchClear':
        researcher.clear(args)
        scheduleOrganization()
        break
      case 'researchSource':
        value = researcher.source(args)
        break
      case 'classificationState':
        value = classifier.state()
        break
      case 'classificationRun':
        classifier.runNow()
        break
      case 'classificationAutomatic':
        classifier.automatic(args)
        port.postMessage({ event: { kind: 'library' } })
        break
      case 'classificationTrack':
        value = classifier.track(args)
        break
      case 'classificationRules':
        value = classifier.rules()
        break
      case 'classificationRulePreview':
        value = await classifier.preview(args)
        break
      case 'classificationRuleCancel':
        classifier.cancelPreview()
        break
      case 'classificationRuleSave':
        classifier.saveRule(args)
        port.postMessage({ event: { kind: 'library' } })
        break
      case 'classificationRuleRemove':
        classifier.removeRule(args)
        port.postMessage({ event: { kind: 'library' } })
        break
      case 'eraYear':
        classifier.eraYear(args)
        scheduleOrganization()
        port.postMessage({ event: { kind: 'library' } })
        break
      case 'review':
        db.updateDecision(args.changes, 'review', args.action)
        if (classifier.state().automatic) classifier.start()
        scheduleOrganization()
        port.postMessage({ event: { kind: 'library' } })
        value = null
        break
      case 'inspect':
        value = await helper.inspect(args)
        break
      case 'shutdown':
        organizationClosing = true
        if (organizationTimer) clearTimeout(organizationTimer)
        await organization.close()
        await trashLibrary.close()
        await trash.close()
        await automation.close()
        await cleanup.close()
        await preparation.close()
        await hashes.close()
        scanner.cancel()
        await scanner.wait()
        await rekordbox.close()
        await researcher.close()
        await classifier.close()
        helper.close()
        db.close()
        value = null
        break
      default:
        throw new Error('Unknown library-service command.')
    }
    port.postMessage({ id, ok: true, value })
  } catch (e) {
    port.postMessage({
      id,
      ok: false,
      error: e instanceof Error ? e.message : 'Library service failed',
    })
  }
})
void rekordbox
  .initialize()
  .then(() => {
    port.postMessage({ ready: true })
    classifier.schedule()
    scheduleOrganization()
  })
  .catch(e => {
    console.error(e)
    process.exit(1)
  })

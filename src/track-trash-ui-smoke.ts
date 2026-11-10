// Packaged smoke only: one new copy of the bundled generated demo fixture.
import type { BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, readFile, lstat, link, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Source, Track } from './shared'
import type { TrackTrashRecord } from './track-trash-types'

export async function trackTrashUISmoke(
  win: BrowserWindow,
  call: (method: string, args?: unknown) => Promise<any>,
  profile: string
) {
  const execute = (code: string) => win.webContents.executeJavaScript(code)
  const wait = async (condition: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (await condition()) return
      await new Promise(resolve => setTimeout(resolve, 80))
    }
    throw Error(
      `Trash UI smoke: ${label}; ${(await execute('document.body.innerText')).slice(-2600)}`
    )
  }
  const idle = () =>
    wait(async () => {
      const classification = await call('classificationState')
      const organization = await call('organizationState')
      const summary = await call('summary')
      return (
        !classification.pending &&
        classification.lastJob?.status !== 'running' &&
        !organization.pending &&
        summary.lastScan?.status !== 'running'
      )
    }, 'scan, classification and tag jobs complete')
  const query = {
    search: '',
    view: 'all',
    sort: 'title',
    direction: 'asc',
    offset: 0,
    limit: 500,
  }
  const search = (value: string) =>
    execute(
      `(()=>{const input=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`
    )
  const sources = (await call('sources')) as Source[]
  const demoSources = new Set(sources.filter(source => source.demo).map(source => source.id))
  const catalog = (await call('list', query)).tracks as Track[]
  const fixture = catalog.find(
    track =>
      demoSources.has(track.sourceId) &&
      track.availability === 'available' &&
      path.extname(track.path).toLowerCase() === '.wav'
  )
  if (!fixture) throw Error('Trash UI smoke needs a bundled synthetic demo WAV.')
  // Scanner excludes the profile itself. Keep this generated source beside it
  // so the smoke exercises the normal source boundary without an exception.
  const root = await mkdtemp(profile + '-generated-trash-library-')
  const filePath = path.join(root, 'Synthetic selected Trash UI.wav')
  await copyFile(fixture.path, filePath)
  const keptPath = path.join(root, 'Synthetic original kept UI.wav')
  const keptLink = path.join(root, 'Synthetic original kept link.wav')
  await copyFile(fixture.path, keptPath)
  await link(keptPath, keptLink)
  const hash = async (file: string) =>
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex')
  const before = await hash(filePath)
  const retainedBefore = await hash(fixture.path)
  const keptBefore = await hash(keptPath)
  const source = (await call('addSource', {
    path: root,
    demo: false,
    broad: false,
  })) as Source
  await call('scan', { kind: 'discovery', sources: [source] })
  await wait(async () => {
    const summary = await call('summary')
    return (
      summary.lastScan?.status === 'completed' && summary.lastScan.sourceIds?.includes(source.id)
    )
  }, 'the new synthetic source alone is scanned')
  await idle()
  const added = (await call('list', { ...query, search: path.basename(filePath) })).tracks.find(
    (track: Track) => track.path === filePath
  ) as Track | undefined
  if (!added) throw Error('The generated Trash test file was not inventoried.')
  const kept = (await call('list', { ...query, search: 'Synthetic original kept' })).tracks.find(
    (track: Track) => track.path === keptPath || track.path === keptLink
  ) as Track | undefined
  if (!kept) throw Error('The generated hard-linked fallback file was not inventoried.')
  let junkIds: string[] = []
  let complete = false
  try {
    await execute("document.querySelector('[data-view=all]').click()")
    await execute(
      `(()=>{const input=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(path.basename(filePath))});input.dispatchEvent(new Event('input',{bubbles:true}));})()`
    )
    await wait(
      () =>
        execute(
          `!!document.querySelector('[data-track-id="${added.id}"]') && document.querySelectorAll('tr[data-track-id]').length === 1`
        ),
      'generated file visible in All Music'
    )
    await execute(
      `document.querySelector('[data-track-id="${added.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
    )
    await wait(
      () =>
        execute(
          "!!document.querySelector('#track-trash-selected') && !document.querySelector('#track-trash-selected').disabled"
        ),
      'selected-song Trash action available'
    )
    await execute("document.querySelector('#track-trash-selected').click()")
    await wait(
      () =>
        execute(
          "!!document.querySelector('.modal-overlay .button.danger') && !document.querySelector('.modal-overlay .button.danger').disabled"
        ),
      'fresh one-file preview ready for explicit final confirmation'
    )
    const preview = await execute(
      `document.querySelector('.modal-overlay').innerText.includes(${JSON.stringify(filePath)}) && document.querySelector('.modal-overlay').innerText.includes('Rekordbox track references')`
    )
    if (
      !preview ||
      (await hash(filePath)) !== before ||
      (await call('get', added.id)).availability !== 'available'
    )
      throw Error('Trash preview changed the file or omitted its path/reference evidence.')
    await execute(
      "Promise.all(document.querySelector('.modal-overlay').getAnimations({subtree:true}).filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))"
    )
    await writeFile(
      path.join(profile, 'trash-preview.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    await execute("document.querySelector('.modal-overlay .button.danger').click()")
    await wait(
      async () => (await call('get', added.id)).availability === 'trashed',
      'explicit UI action moves the selected file'
    )
    await wait(
      () =>
        execute(
          "[...document.querySelectorAll('.modal-overlay button')].some(button=>button.textContent.trim()==='Restore this batch' && !button.disabled)"
        ),
      'UI offers restore for the confirmed move'
    )
    const history = (await call('trackTrashHistory')) as TrackTrashRecord[]
    const record = history.find(
      entry => entry.moved === 1 && entry.restored === 0 && entry.status === 'completed'
    )
    if (!record)
      throw Error('The native UI move did not create a completed durable recovery batch.')
    const originalPresent = await lstat(filePath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false
        throw error
      }
    )
    if (originalPresent) throw Error('The native UI move left the original path occupied.')
    await idle()
    await execute("document.querySelector('.modal-close').click()")
    await wait(
      () => execute("!document.querySelector('.modal-overlay')"),
      'native-move result closes'
    )
    await execute("document.querySelector('[data-view=all]').click()")
    await execute(
      `(()=>{const input=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(kept.filename)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`
    )
    await wait(
      () =>
        execute(
          `!!document.querySelector('[data-track-id="${kept.id}"]') && document.querySelectorAll('tr[data-track-id]').length === 1`
        ),
      'hard-linked fallback file visible'
    )
    const fallbackPreview = await call('trackTrashPreview', [
      { id: kept.id, revision: (await call('get', kept.id)).revision },
    ])
    if (
      fallbackPreview.catalogOnly !== 1 ||
      fallbackPreview.files[0]?.action !== 'remove-from-library'
    )
      throw Error('Hard-linked fixture did not receive an explicit catalog-only preview.')
    await execute(
      `document.querySelector('[data-track-id="${kept.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
    )
    await wait(
      () =>
        execute(
          "!!document.querySelector('#track-trash-selected') && !document.querySelector('#track-trash-selected').disabled"
        ),
      'fallback selection action available'
    )
    await execute("document.querySelector('#track-trash-selected').click()")
    await wait(
      () =>
        execute(
          "!!document.querySelector('.modal-overlay .button.danger') && !document.querySelector('.modal-overlay .button.danger').disabled"
        ),
      'catalog-only fallback confirmation ready'
    )
    await execute("document.querySelector('.modal-overlay .button.danger').click()")
    await wait(
      async () => (await call('get', kept.id)).availability === 'removed',
      'catalog-only fallback removes entry'
    )
    await wait(
      () => execute("!document.querySelector('.modal-close').disabled"),
      'catalog-only fallback completes'
    )
    if ((await hash(keptPath)) !== keptBefore || (await hash(keptLink)) !== keptBefore)
      throw Error('Catalog-only fallback moved or modified an original hard link.')
    const hiddenInMain = await call('list', {
      ...query,
      search: kept.filename,
    })
    const hiddenInTrash = await call('list', {
      ...query,
      view: 'trash',
      search: kept.filename,
    })
    if (hiddenInMain.total !== 0 || hiddenInTrash.total !== 0)
      throw Error(
        'A blocked original remains visible in the active library or physical Trash view.'
      )
    await execute(
      "[...document.querySelectorAll('.modal-overlay button')].find(button=>button.textContent.trim()==='Restore this batch').click()"
    )
    await wait(
      async () => (await call('get', kept.id)).availability === 'available',
      'explicit current-batch catalog-only restore returns the entry'
    )
    await wait(
      () => execute("!document.querySelector('.modal-close').disabled"),
      'catalog-only restore completes'
    )
    await execute("document.querySelector('.modal-close').click()")
    await wait(() => execute("!document.querySelector('.modal-overlay')"), 'fallback dialog closes')
    await execute("document.querySelector('[data-view=trash]').click()")
    await wait(
      () =>
        execute(
          "document.querySelector('[data-view=trash]')?.classList.contains('active') && document.querySelectorAll('tr[data-track-id]').length === 1"
        ),
      'Trash library displays only the confirmed physical move'
    )
    const trashFirst = await call('list', {
      ...query,
      view: 'trash',
      limit: 1,
    })
    const trashSecond = await call('list', {
      ...query,
      view: 'trash',
      limit: 1,
      offset: 1,
    })
    if (
      trashFirst.total !== 1 ||
      trashSecond.total !== 1 ||
      trashFirst.tracks.length !== 1 ||
      trashSecond.tracks.length !== 0
    )
      throw Error('Trash library includes an entry that was not physically moved.')
    const trashTracks = [...trashFirst.tracks, ...trashSecond.tracks] as Track[]
    const movedMetadata = trashTracks.find(track => track.id === added.id)?.trash
    if (
      movedMetadata?.state !== 'in-trash' ||
      movedMetadata.originalPath !== filePath ||
      !movedMetadata.trashPath ||
      !movedMetadata.removedAt
    )
      throw Error('Trash library omitted confirmed physical-move metadata.')
    await execute(
      `(()=>{const input=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(path.basename(filePath))});input.dispatchEvent(new Event('input',{bubbles:true}));})()`
    )
    await new Promise(resolve => setTimeout(resolve, 250))
    await wait(
      () =>
        execute(
          `!!document.querySelector('[data-track-id="${added.id}"]') && document.querySelectorAll('tr[data-track-id]').length === 1`
        ),
      'Trash library search finds a moved track'
    )
    const searched = await call('list', {
      ...query,
      view: 'trash',
      search: path.basename(filePath),
    })
    if (searched.total !== 1 || searched.tracks[0].id !== added.id)
      throw Error('Trash search returned incorrect membership.')
    await execute(
      `document.querySelector('[data-track-id="${added.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
    )
    await wait(
      () =>
        execute(
          "document.querySelector('.trash-details')?.dataset.trashState === 'in-trash' && !!document.querySelector('#trash-restore-selected')"
        ),
      'Trash details expose recorded physical state'
    )
    const safeTrashActions = await execute(
      "!document.querySelector('#playlist-destination') && !document.querySelector('#track-trash-selected') && !document.querySelector('.organization-editor')"
    )
    if (!safeTrashActions)
      throw Error('Normal tag/playlist/Trash actions remain active inside Trash library.')
    await writeFile(
      path.join(profile, 'trash-library.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    await wait(
      () =>
        execute(
          "document.querySelectorAll('tr[aria-selected=true]').length === 1 && !!document.querySelector('#trash-restore-selected') && !document.querySelector('#trash-restore-selected').disabled"
        ),
      'physical Trash entry selected for restore'
    )
    await execute("document.querySelector('#trash-restore-selected').click()")
    await wait(
      async () =>
        (await call('get', added.id)).availability === 'available' &&
        (await call('get', kept.id)).availability === 'available',
      'UI restore returns the selected file to its original path'
    )
    await wait(
      () =>
        execute(
          "document.querySelectorAll('tr[data-track-id]').length === 0 && !document.querySelector('.modal-overlay')"
        ),
      'restored entries leave Trash library'
    )
    const restored = ((await call('trackTrashHistory')) as TrackTrashRecord[]).find(
      entry => entry.id === record.id
    )
    if (
      restored?.status !== 'restored' ||
      restored.restored !== 1 ||
      (await hash(filePath)) !== before ||
      (await hash(keptPath)) !== keptBefore ||
      (await hash(keptLink)) !== keptBefore ||
      (await hash(fixture.path)) !== retainedBefore
    )
      throw Error('UI restore did not preserve the original bytes and confirmed journal state.')
    await writeFile(
      path.join(profile, 'trash-restored.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    // Fresh files avoid reusing a just-restored macOS Trash item while Finder
    // may still update its metadata. Write generated audio bytes into new files
    // instead of copying filesystem attributes or a prior Trash identity.
    const junkPaths = [
      path.join(root, 'Synthetic Junk A.wav'),
      path.join(root, 'Synthetic Junk B.wav'),
    ]
    const generatedBytes = await readFile(fixture.path)
    await writeFile(junkPaths[0]!, generatedBytes)
    await writeFile(junkPaths[1]!, generatedBytes)
    await call('scan', { kind: 'discovery', sources: [source] })
    await wait(async () => {
      const summary = await call('summary')
      return (
        summary.lastScan?.status === 'completed' && summary.lastScan.sourceIds?.includes(source.id)
      )
    }, 'fresh generated Junk files inventoried')
    await idle()
    if ((await call('list', { ...query, view: 'category', value: '_JUNK' })).total !== 0)
      throw Error('Junk smoke requires no unrelated generated Junk entries.')
    const junkTracks = (
      (await call('list', { ...query, search: 'Synthetic Junk' })).tracks as Track[]
    ).filter(track => junkPaths.includes(track.path))
    if (junkTracks.length !== 2 || junkTracks.some(track => track.availability !== 'available'))
      throw Error('Fresh generated Junk files were not safely inventoried.')
    junkIds = junkTracks.map(track => track.id)
    const junkA = junkTracks.find(track => track.path === junkPaths[0])!
    const junkB = junkTracks.find(track => track.path === junkPaths[1])!
    await call('classify', {
      changes: junkTracks.map(track => ({
        id: track.id,
        revision: track.revision,
      })),
      category: '_JUNK',
    })
    await idle()
    const nativeReady = await call('trackTrashPreviewJunk')
    if (nativeReady.total !== 2 || nativeReady.catalogOnly !== 0)
      throw Error(
        'Fresh generated Junk files failed native preflight: ' +
          JSON.stringify(
            nativeReady.files.map((file: { path: string; action?: string; reason?: string }) => ({
              path: file.path,
              action: file.action,
              reason: file.reason,
            }))
          )
      )
    await execute("document.querySelector('[data-view=junk]').click()")
    await wait(
      () =>
        execute(
          "document.querySelector('[data-view=junk]')?.classList.contains('active') && document.querySelectorAll('tr[data-track-id]').length === 2 && !!document.querySelector('#track-trash-all-junk')"
        ),
      'Junk navigation shows its complete collection and all-Junk action'
    )
    const junkScopeGuard = await execute(
      "window.organizer.trackTrashPreviewJunk({scope:'selected',ids:[],path:'/tmp/never-a-music-path'}).then(value=>value.scope==='junk' && value.total===2,()=>true)"
    )
    if (!junkScopeGuard) throw Error('Junk preview accepted renderer-supplied scope or paths.')
    await search(junkA.filename)
    await wait(
      () =>
        execute(
          `!!document.querySelector('[data-track-id="${junkA.id}"]') && document.querySelectorAll('tr[data-track-id]').length === 1`
        ),
      'Junk search narrows visible rows'
    )
    await execute(
      `document.querySelector('[data-track-id="${junkA.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
    )
    await wait(
      () => execute("document.querySelectorAll('tr[aria-selected=true]').length === 1"),
      'only one searched Junk row selected'
    )
    async function openAllJunk() {
      await execute("document.querySelector('#track-trash-all-junk').click()")
      await wait(
        () =>
          execute(
            "!!document.querySelector('#track-trash-scope-note') && !!document.querySelector('.modal-overlay .button.danger') && !document.querySelector('.modal-overlay .button.danger').disabled && document.querySelector('.modal-overlay .button.danger').textContent.includes('all 2 songs in Junk')"
          ),
        'all-Junk preview covers both files despite search and selection'
      )
      const completePreview = await execute(
        `document.querySelector('#track-trash-scope-note').textContent.includes('regardless') && document.querySelector('.modal-overlay').innerText.includes(${JSON.stringify(junkA.path)}) && document.querySelector('.modal-overlay').innerText.includes(${JSON.stringify(junkB.path)})`
      )
      if (!completePreview)
        throw Error('All-Junk confirmation omitted its full scope or a file path.')
    }
    await openAllJunk()
    await execute(
      "[...document.querySelectorAll('.modal-overlay button')].find(button=>button.textContent.trim()==='Cancel').click()"
    )
    await wait(
      () => execute("!document.querySelector('.modal-overlay')"),
      'all-Junk preview cancels'
    )
    if (
      (await hash(junkA.path)) !== retainedBefore ||
      (await hash(junkB.path)) !== retainedBefore ||
      (await call('list', { ...query, view: 'category', value: '_JUNK' })).total !== 2
    )
      throw Error('Canceling the all-Junk preview changed files or membership.')
    await openAllJunk()
    await writeFile(
      path.join(profile, 'junk-all-preview.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    await execute("document.querySelector('.modal-overlay .button.danger').click()")
    await wait(
      async () =>
        (await call('get', junkA.id)).availability === 'trashed' &&
        (await call('get', junkB.id)).availability === 'trashed',
      'confirmed all-Junk action moves both generated files'
    )
    await wait(
      () =>
        execute(
          "!!document.querySelector('#view-trash-library') && !document.querySelector('#view-trash-library').disabled"
        ),
      'Junk result offers physical Trash navigation'
    )
    if ((await call('list', { ...query, view: 'category', value: '_JUNK' })).total !== 0)
      throw Error('Confirmed Junk batch left processed entries in Junk.')
    await execute("document.querySelector('#view-trash-library').click()")
    await wait(
      () =>
        execute(
          "document.querySelector('[data-view=trash]')?.classList.contains('active') && document.querySelectorAll('tr[data-track-id]').length === 2"
        ),
      'Junk result opens both physical Trash files'
    )
    const junkFirst = await call('list', { ...query, view: 'trash', limit: 1 })
    const junkSecond = await call('list', {
      ...query,
      view: 'trash',
      offset: 1,
      limit: 1,
    })
    if (
      junkFirst.total !== 2 ||
      junkSecond.total !== 2 ||
      junkFirst.tracks.length !== 1 ||
      junkSecond.tracks.length !== 1 ||
      junkFirst.tracks[0].id === junkSecond.tracks[0].id
    )
      throw Error('Physical Trash pagination lost a generated Junk file.')
    await execute(
      `document.querySelector('[data-track-id="${junkA.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
    )
    await wait(
      () => execute("document.querySelectorAll('tr[aria-selected=true]').length === 1"),
      'first Junk Trash file selected'
    )
    await execute(
      `document.querySelector('[data-track-id="${junkB.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))`
    )
    await wait(
      () =>
        execute(
          "document.querySelectorAll('tr[aria-selected=true]').length === 2 && !document.querySelector('#trash-restore-selected').disabled"
        ),
      'both physical Junk files selected for restore'
    )
    await execute("document.querySelector('#trash-restore-selected').click()")
    await wait(
      async () =>
        (await call('get', junkA.id)).availability === 'available' &&
        (await call('get', junkB.id)).availability === 'available',
      'Junk fixture batch restored through physical Trash'
    )
    await wait(
      () => execute("document.querySelectorAll('tr[data-track-id]').length === 0"),
      'restored Junk files leave physical Trash'
    )
    if (
      (await hash(junkA.path)) !== retainedBefore ||
      (await hash(junkB.path)) !== retainedBefore ||
      (await hash(filePath)) !== before ||
      (await hash(keptPath)) !== keptBefore ||
      (await hash(keptLink)) !== keptBefore ||
      (await hash(fixture.path)) !== retainedBefore
    )
      throw Error('Junk removal/restore changed generated audio bytes or the bundled original.')
    await execute(
      "(()=>{const input=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-view=practice]').click();})()"
    )
    await idle()
    await wait(
      () =>
        execute(
          "document.querySelector('[data-view=practice]')?.classList.contains('active') && document.querySelectorAll('tr[data-track-id]').length > 1"
        ),
      'practice navigation restored'
    )
    complete = true
    return {
      generatedFixtureOnly: true,
      explicitPreview: preview,
      nativeTrashThroughUI: true,
      durableRecoveryBatch: true,
      nativeRestoreThroughUI: true,
      catalogOnlyOriginalKept: true,
      catalogOnlyHidden: true,
      junkNavigation: true,
      junkAllScopePreview: true,
      junkCancelNoEffects: true,
      junkConfirmed: true,
      junkScopeGuard,
      trashLibraryMetadata: true,
      trashLibraryPagination: true,
      trashLibrarySearch: true,
      trashLibrarySafeActions: safeTrashActions,
      trashLibraryRestoreSelected: true,
      restoredBytesUnchanged: true,
      originalDemoUntouched: true,
      practiceNavigationRestored: true,
    }
  } finally {
    if (!complete) {
      // A UI assertion must not leave the new fixture in Trash. Recovery is
      // limited to this test's fresh batch and original workspace path.
      try {
        await idle()
        const pending = await Promise.all(
          [added.id, kept.id, ...junkIds].map(id => call('get', id))
        )
        const changes = pending
          .filter(track => ['trashed', 'removed'].includes(track?.availability))
          .map(track => ({ id: track.id, revision: track.revision }))
        if (changes.length) await call('trashRestoreFiles', changes)
      } catch (error) {
        await writeFile(
          path.join(profile, 'trash-ui-cleanup-error.txt'),
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }
}

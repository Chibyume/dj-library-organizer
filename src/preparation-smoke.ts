// Explicit synthetic test profile only. Exercises the actual sandboxed UI and export chooser boundary.
import type { BrowserWindow } from 'electron'
import { dialog } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
export async function preparationSmoke(
  win: BrowserWindow,
  call: (method: string, args?: unknown) => Promise<any>,
  profile: string
) {
  const execute = (code: string) => win.webContents.executeJavaScript(code)
  async function wait(condition: () => Promise<boolean>, label: string) {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (await condition()) return
      await new Promise(r => setTimeout(r, 80))
    }
    throw new Error(
      `Preparation smoke timed out: ${label}; ${(await execute("document.querySelector('.prepare-workflow')?.innerText || document.body.innerText")).slice(-2400)}`
    )
  }
  await wait(async () => {
    const c = await call('classificationState')
    return !c.pending && c.lastJob?.status !== 'running'
  }, 'classification idle')
  await execute('document.querySelector(\'[aria-label="Prepare for rekordbox"]\').click()')
  await wait(() => execute("!!document.querySelector('#duplicate-run')"), 'workflow opens')
  const noPrematureExport = await execute("document.querySelector('#preparation-export').disabled")
  const pathInjectionRejected = await execute(
    "window.organizer.preparationExport({token:'bad',parent:'/tmp'}).then(()=>false,()=>true)"
  )
  await execute("document.querySelector('#duplicate-run').click()")
  await wait(async () => {
    const job = await call('duplicateState')
    return job?.status === 'completed'
  }, 'full hashes completed')
  await wait(
    () =>
      execute(
        "document.querySelectorAll('.duplicate-member').length>=2 && [...document.querySelectorAll('.duplicate-member button')].some(b=>b.textContent==='Use only this copy' && !b.disabled)"
      ),
    'duplicate group visible'
  )
  await writeFile(
    path.join(profile, 'duplicate-review.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  await execute(
    "[...document.querySelectorAll('.prepare-workflow button')].find(b=>b.textContent==='Pick best copies for me').click()"
  )
  await wait(
    () =>
      execute(
        "document.querySelector('.duplicate-group summary')?.textContent.includes('Reviewed')"
      ),
    'keeper saved'
  )
  const automaticCopies = (await call('duplicateList', 0)).unresolved === 0
  const overrideControls = await execute(
    "[...document.querySelectorAll('.prepare-workflow label')].some(l=>l.textContent.includes('Include extras referenced by Rekordbox')) && [...document.querySelectorAll('.prepare-workflow label')].some(l=>l.textContent.includes('Re-pick previously saved'))"
  )
  if (!overrideControls) throw new Error('Missing bulk override controls.')
  const inclusivePreview = await call('cleanupPreview', {
    includeReferenced: true,
  })
  if (inclusivePreview.files || !inclusivePreview.includeReferenced)
    throw new Error('Referenced override must preserve demo-source protection.')
  const cleanupPreview = await call('cleanupPreview')
  if (cleanupPreview.files !== 0)
    throw new Error('Packaged demo must not be eligible for physical cleanup.')
  const cleanupTokenGuard = await execute(
    "window.organizer.cleanupStart({path:'/tmp'}).then(()=>false,()=>true)"
  )
  await execute("document.querySelector('#preparation-preview').click()")
  await wait(
    () =>
      execute(
        "!!document.querySelector('#preparation-approve') && !document.querySelector('#preparation-approve').disabled"
      ),
    'eligible preview'
  )
  // Exercise the user's formerly blocked path through the one shared Review view.
  const reviewPlan = await call('preparationPreview', {
    scope: 'all',
    ids: [],
  })
  const reviewRows = (
    await call('preparationPage', {
      token: reviewPlan.token,
      offset: 0,
      filter: 'eligible',
    })
  ).items.slice(0, 3)
  if (reviewRows.length !== 3)
    throw new Error('Need three synthetic eligible tracks for review controls.')
  const reviewTracks = await Promise.all(reviewRows.map((row: any) => call('get', row.id)))
  await call('review', {
    changes: reviewTracks.map((track: any) => ({
      id: track.id,
      revision: track.revision,
    })),
    action: 'review',
  })
  await wait(async () => {
    const state = await call('classificationState')
    return !state.pending && state.lastJob?.status !== 'running'
  }, 'review evidence refreshed')
  await execute("document.querySelector('#preparation-preview').click()")
  await wait(
    () =>
      execute(
        "!!document.querySelector('#preparation-review-held') && !document.querySelector('#preparation-review-held').disabled"
      ),
    'held review available'
  )
  await execute("document.querySelector('#preparation-review-held').click()")
  await wait(
    () =>
      execute(
        `!!document.querySelector('#review-filter') && !!document.querySelector('[data-track-id="${reviewRows[0].id}"]') && !document.querySelector('.prepare-workflow')`
      ),
    'same held row displayed in Library Review'
  )
  const choose = (selector: string, value: string) =>
    execute(
      `(()=>{const select=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(value)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`
    )
  const input = (selector: string, value: string) =>
    execute(
      `(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`
    )
  await execute(
    `document.querySelector('[data-track-id="${reviewRows[0].id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
  )
  await wait(
    () => execute("!!document.querySelector('#organization-tag-value')"),
    'shared tag editor displayed'
  )
  win.setSize(1100, 700)
  await new Promise(resolve => setTimeout(resolve, 200))
  const reviewFitsNarrow = await execute(
    'document.documentElement.scrollWidth <= document.documentElement.clientWidth'
  )
  await writeFile(
    path.join(profile, 'preparation-review-narrow.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  win.setSize(1480, 920)
  await choose('#organization-tag-group', 'genre')
  await input('#organization-tag-value', 'Jersey Club')
  await wait(
    () => execute("!document.querySelector('#organization-tag-add').disabled"),
    'individual genre tag enabled'
  )
  await execute("document.querySelector('#organization-tag-add').click()")
  await wait(async () => {
    const track = await call('get', reviewRows[0].id)
    return track.category === 'Jersey Club' && track.review === 'Ready for Approval'
  }, 'individual genre tag and export category saved')
  await wait(async () => {
    const state = await call('classificationState')
    return !state.pending && state.lastJob?.status !== 'running'
  }, 'individual classification refreshed')
  await wait(
    () => execute(`!document.querySelector('[data-track-id="${reviewRows[0].id}"]')`),
    'saved individual track leaves held view'
  )
  await wait(
    () =>
      execute(
        `!!document.querySelector('[data-track-id="${reviewRows[1].id}"] input[type=checkbox]') && !!document.querySelector('[data-track-id="${reviewRows[2].id}"] input[type=checkbox]')`
      ),
    'bulk selection available'
  )
  await execute(
    `document.querySelector('[data-track-id="${reviewRows[1].id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
  )
  await wait(
    () =>
      execute(
        `document.querySelectorAll('tr[aria-selected=true]').length === 1 && document.querySelector('tr[aria-selected=true]')?.dataset.trackId === '${reviewRows[1].id}'`
      ),
    'first bulk track selection committed'
  )
  await execute(
    `document.querySelector('[data-track-id="${reviewRows[2].id}"] input[type=checkbox]').click()`
  )
  await wait(
    () =>
      execute(
        `document.querySelectorAll('tr[aria-selected=true]').length === 2 && document.querySelector('[data-track-id="${reviewRows[1].id}"]')?.getAttribute('aria-selected') === 'true' && document.querySelector('[data-track-id="${reviewRows[2].id}"]')?.getAttribute('aria-selected') === 'true' && !!document.querySelector('#organization-tag-value')`
      ),
    'two tracks selected in shared tag editor'
  )
  await choose('#organization-tag-group', 'genre')
  await input('#organization-tag-value', 'Pop')
  await wait(
    () => execute("!document.querySelector('#organization-tag-add').disabled"),
    'bulk genre tag enabled'
  )
  await execute("document.querySelector('#organization-tag-add').click()")
  await wait(async () => {
    const tracks = await Promise.all(reviewRows.slice(1).map((row: any) => call('get', row.id)))
    return tracks.every(
      (track: any) => track.category === 'Pop' && track.review === 'Ready for Approval'
    )
  }, 'bulk category saved')
  await wait(async () => {
    const state = await call('classificationState')
    return !state.pending && state.lastJob?.status !== 'running'
  }, 'saved genre classifications refreshed')
  await call('organizationRun')
  await execute('document.querySelector(\'[aria-label="Prepare for rekordbox"]\').click()')
  await wait(
    () => execute("!!document.querySelector('#preparation-preview')"),
    'preparation reopened after central review'
  )
  await execute("document.querySelector('#preparation-preview').click()")
  await wait(
    () =>
      execute(
        "!!document.querySelector('#preparation-approve') && !document.querySelector('#preparation-approve').disabled"
      ),
    'updated tags eligible for playlist approval'
  )
  const reviewIPCGuard = await execute(
    "window.organizer.preparationClassify({token:'bad',ids:[],category:'_JUNK'}).then(()=>false,()=>true)"
  )
  await choose('[aria-label="Preparation track filter"]', 'eligible')
  const heldVisible = await execute(
    "document.querySelector('.prepare-workflow').innerText.includes('held for review')"
  )
  await execute("document.querySelector('#preparation-approve').click()")
  await wait(
    () =>
      execute(
        "!document.querySelector('#preparation-export').disabled && document.querySelector('#preparation-approve').disabled"
      ),
    'classifications approved'
  )
  await execute("document.querySelector('#preparation-preview').scrollIntoView({block:'start'})")
  await new Promise(r => setTimeout(r, 150))
  await writeFile(
    path.join(profile, 'playlist-preparation.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  const destination = path.join(profile, 'synthetic-exports')
  await mkdir(destination)
  const original = dialog.showOpenDialog
  try {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [destination],
    })) as typeof dialog.showOpenDialog
    await execute("document.querySelector('#preparation-export').click()")
    await wait(async () => {
      const h = await call('preparationHistory')
      return h[0]?.status === 'exported'
    }, 'playlist files saved')
  } finally {
    dialog.showOpenDialog = original
  }
  await wait(() => execute("!!document.querySelector('.export-record')"), 'export history visible')
  const record = (await call('preparationHistory'))[0]
  const xml = await readFile(path.join(record.directory, 'rekordbox.xml'), 'utf8')
  const manifest = JSON.parse(await readFile(path.join(record.directory, 'manifest.json'), 'utf8'))
  const found = await call('xmlFind', [path.join(record.directory, 'rekordbox.xml')])
  if (!found.candidates[0]?.valid || found.candidates[0]?.tracks !== record.tracks)
    throw new Error('Generated export failed parser round trip.')
  if (manifest.tracks.length !== record.tracks || !xml.includes('DJ Library Organizer'))
    throw new Error('Export manifest/namespace mismatch.')
  await readFile(path.join(record.directory, 'COMPLETE.txt'))
  await execute("document.querySelector('.export-record').scrollIntoView({block:'center'})")
  await new Promise(r => setTimeout(r, 150))
  await writeFile(
    path.join(profile, 'playlist-export.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  // The generated file must never verify itself.
  await call('xmlImport', found.candidates[0].id)
  const own = await call('preparationVerify', record.id)
  if (own.verification?.status !== 'inconclusive') throw new Error('Own export verified itself.')
  // Synthetic native-export fixture only: not evidence of actual rekordbox behavior.
  const nativeXML = path.join(profile, 'synthetic-native-export.xml')
  await writeFile(
    nativeXML,
    xml.replace(
      /<PRODUCT [^>]+\/>/,
      '<PRODUCT Name="rekordbox" Version="7.2.14 - SYNTHETIC TEST" Company="Synthetic fixture"/>'
    )
  )
  const native = await call('xmlFind', [nativeXML])
  await call('xmlImport', native.candidates[0].id)
  await execute("document.querySelector('[data-verify-export]').click()")
  await wait(
    () =>
      execute("document.querySelector('.export-verification')?.dataset.verification === 'matched'"),
    'snapshot verification displayed'
  )
  const checked = (await call('preparationHistory'))[0]
  if (checked.verification?.matched !== record.tracks || checked.reportedImportedAt !== null)
    throw new Error('Snapshot comparison count or reported-import distinction failed.')
  const rejectedVerificationPath = await execute(
    "window.organizer.preparationVerify({id:'bad',path:'/tmp/fake.xml'}).then(()=>false,()=>true)"
  )
  if (!rejectedVerificationPath) throw new Error('Verification IPC accepted a path.')
  await execute("document.querySelector('.export-verification').scrollIntoView({block:'center'})")
  await new Promise(r => setTimeout(r, 150))
  await writeFile(
    path.join(profile, 'playlist-verification.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  await execute("document.querySelector('.modal-close').click()")
  return {
    categoryReview: true,
    bulkCategoryReview: true,
    reviewFitsNarrow,
    reviewIPCGuard,
    automaticCopies,
    overrideControls,
    overrideDemoProtected: inclusivePreview.files === 0,
    cleanupDemoProtected: cleanupPreview.files === 0,
    cleanupTokenGuard,
    noPrematureExport,
    pathInjectionRejected,
    heldVisible,
    hashesChecked: (await call('duplicateState')).checked,
    keeperSaved: true,
    batchApproved: true,
    exportedTracks: record.tracks,
    xmlRoundTrip: true,
    manifestMatches: true,
    importNotClaimed: record.reportedImportedAt === null,
    ownExportRejected: true,
    snapshotMembershipMatched: true,
    verificationPathRejected: rejectedVerificationPath,
  }
}

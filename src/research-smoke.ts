import type { BrowserWindow } from 'electron'
import type { Track } from './shared'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { inputDigest, researchInput } from './research-identity'
import { writeFile, readdir } from 'node:fs/promises'
export async function researchSmoke(
  win: BrowserWindow,
  call: (method: string, args?: unknown) => Promise<any>,
  profile: string,
  tracks: Track[]
) {
  const execute = (code: string) => win.webContents.executeJavaScript(code)
  async function wait(condition: () => Promise<boolean>, label: string) {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (await condition()) return
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error(`Research smoke timed out: ${label}`)
  }
  const track = tracks.find(t => t.title === 'Sin Fecha')!
  await execute("document.querySelector('[data-view=review]').click()")
  await wait(() => execute("!!document.querySelector('#review-filter')"), 'central Review opens')
  await execute(
    "(()=>{const select=document.querySelector('#review-filter');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'all');select.dispatchEvent(new Event('change',{bubbles:true}));})()"
  )
  await wait(
    () => execute(`!!document.querySelector('[data-track-id="${track.id}"]')`),
    'research track visible in Review'
  )
  await execute(
    `document.querySelector('[data-track-id="${track.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
  )
  await wait(
    async () =>
      await execute(
        `document.querySelector('.selected-track h2')?.textContent===${JSON.stringify(track.title)}`
      ),
    'selected track'
  )
  await execute('document.querySelector(\'[aria-label="Online research"]\').click()')
  await wait(
    async () =>
      await execute('!!document.querySelector(\'[aria-label="Preview research batch"]\')'),
    'research modal'
  )
  await execute('document.querySelector(\'[aria-label="Preview research batch"]\').click()')
  await wait(
    async () => await execute("!!document.querySelector('.research-preview')"),
    'sharing preview'
  )
  const musicBrainzOnly = await execute(
    "document.querySelector('.research-settings')?.innerText.includes('MusicBrainz') && !document.querySelector('.research-settings')?.innerText.includes('AI web research') && !document.querySelector('[aria-label=\"OpenAI API key\"]')"
  )
  const preview = await execute(
    "({text:document.querySelector('.research-preview').innerText,disabled:document.querySelector('[aria-label=\"Start previewed research\"]').disabled})"
  )
  if (
    !preview.disabled ||
    !preview.text.includes(track.title) ||
    preview.text.includes(profile) ||
    !preview.text.includes('Tagged year: unknown')
  )
    throw new Error('Research sharing preview or consent guard failed.')
  await execute(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'
  )
  await writeFile(
    path.join(profile, 'research-preview.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  await execute(
    'document.querySelector(\'[aria-label="Allow previewed metadata lookup"]\').click()'
  )
  await wait(
    async () =>
      await execute(
        '!document.querySelector(\'[aria-label="Start previewed research"]\').disabled'
      ),
    'explicit consent'
  )
  await execute('document.querySelector(\'[aria-label="Start previewed research"]\').click()')
  await wait(
    async () => (await call('researchState')).job?.status === 'completed',
    'batch completion'
  )
  await execute('document.querySelector(\'[aria-label="Close dialog"]\').click()')
  await wait(
    async () =>
      await execute(
        "document.querySelector('.track-research')?.innerText.includes('SYNTHETIC TEST RESPONSE')"
      ),
    'research result'
  )
  await wait(
    async () =>
      await execute(
        '!!document.querySelector(\'[aria-label="Approve researched values 1"]\') && !document.querySelector(\'[aria-label="Approve researched values 1"]\').disabled'
      ),
    'approval available'
  )
  await execute('document.querySelector(\'[aria-label="Approve researched values 1"]\').click()')
  await wait(
    async () => (await call('get', track.id)).category === 'Reggaeton New',
    'research-fed classification'
  )
  const updated = await call('get', track.id)
  if (updated.year !== null || updated.genre !== 'Reggaeton' || updated.manual)
    throw new Error('Research overwrote tags or manually approved a category.')
  await wait(
    async () =>
      await execute(
        "document.querySelector('.research-approved')?.innerText.includes('Saved research choice')"
      ),
    'saved research UI'
  )
  await execute("document.querySelector('.track-research').scrollIntoView({block:'start'})")
  await execute(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'
  )
  await writeFile(
    path.join(profile, 'research-result.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  const cached = await call('researchPreview', {
    provider: 'musicbrainz',
    scope: 'selected',
    ids: [track.id],
    limit: 1,
  })
  if (cached.networkTracks !== 0) throw new Error('Research cache was not reused.')

  // Native file-dialog selection is substituted only in isolated smoke mode.
  const evidence = await call('researchTrack', track.id)
  await call('researchClear', {
    id: track.id,
    revision: (await call('get', track.id)).revision,
  })
  const current = await call('get', track.id)
  await writeFile(
    path.join(profile, 'research-import.json'),
    JSON.stringify({
      format: 'dj-library-research-v1',
      id: randomUUID(),
      label: 'Synthetic research import',
      createdAt: new Date().toISOString(),
      entries: [
        {
          fileId: track.id,
          signature: current.signature,
          inputHash: inputDigest(researchInput(current)),
          candidate: evidence.result.candidates[0],
        },
      ],
    })
  )
  await execute('document.querySelector(\'[aria-label="Online research"]\').click()')
  await wait(
    async () => await execute('!!document.querySelector(\'[aria-label="Import research file"]\')'),
    'research import button'
  )
  await execute('document.querySelector(\'[aria-label="Import research file"]\').click()')
  await wait(
    async () =>
      await execute(
        '!!document.querySelector(\'[aria-label="Apply imported research"]\') && !document.querySelector(\'[aria-label="Apply imported research"]\').disabled'
      ),
    'research import preview'
  )
  await writeFile(
    path.join(profile, 'research-import-preview.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  await execute('document.querySelector(\'[aria-label="Apply imported research"]\').click()')
  await wait(
    async () =>
      await execute(
        "document.querySelector('.research-settings')?.innerText.includes('Imported research for 1 tracks')"
      ),
    'research import completion'
  )
  await execute('document.querySelector(\'[aria-label="Close dialog"]\').click()')
  await wait(
    async () => (await call('get', track.id)).category === 'Reggaeton New',
    'imported evidence category'
  )
  let importPathRejected = false
  try {
    await execute("window.organizer.researchImportApply('/tmp/untrusted.json')")
  } catch {
    importPathRejected = true
  }
  if (!importPathRejected)
    throw new Error('Research import accepted a path instead of a preview token.')

  const noKeyBridge = await execute("typeof window.organizer.researchKey === 'undefined'")
  const legacyCredentialRemoved = !(await readdir(profile)).some(
    n => n === 'research-key.encrypted'
  )
  let invalidBatchRejected = false,
    retiredProviderRejected = false
  try {
    await execute(
      "window.organizer.researchPreview({provider:'musicbrainz',scope:'selected',ids:[],limit:51})"
    )
  } catch {
    invalidBatchRejected = true
  }
  try {
    await execute(
      "window.organizer.researchPreview({provider:'openai',scope:'selected',ids:[],limit:1})"
    )
  } catch {
    retiredProviderRejected = true
  }
  if (
    !invalidBatchRejected ||
    !retiredProviderRejected ||
    !noKeyBridge ||
    !musicBrainzOnly ||
    !legacyCredentialRemoved
  )
    throw new Error('MusicBrainz-only research acceptance failed.')
  return {
    importedBatch: true,
    importPathRejected,
    syntheticProvider: true,
    sharingPreview: true,
    consentGuard: true,
    approvalFeedsCategory: true,
    category: updated.category,
    tagsPreserved: true,
    cacheReused: true,
    musicBrainzOnly,
    noKeyBridge,
    legacyCredentialRemoved,
    invalidBatchRejected,
    retiredProviderRejected,
    liveNetwork: false,
  }
}

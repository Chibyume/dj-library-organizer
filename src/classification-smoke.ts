// Explicit generated-fixture smoke only; no production profile or personal files.
import type { BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ClassificationState, Track } from './shared'
export async function classificationSmoke(
  win: BrowserWindow,
  call: (method: string, args?: unknown) => Promise<any>,
  profile: string,
  tracks: Track[]
) {
  const execute = async (code: string): Promise<any> => {
    try {
      return await win.webContents.executeJavaScript(code)
    } catch (error) {
      throw new Error(
        `Classification smoke script failed: ${code}; ${error instanceof Error ? error.message : error}`
      )
    }
  }
  const wait = async (condition: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (await condition()) return
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error(
      `Classification UI timed out: ${label}; UI: ${(await execute('document.body.innerText')).slice(-1800)}`
    )
  }
  const idle = () =>
    wait(async () => {
      const state = (await call('classificationState')) as ClassificationState
      return state.pending === 0 && state.lastJob?.status === 'completed'
    }, 'local classification complete')
  await idle()
  await execute("document.querySelector('[data-view=review]').click()")
  await wait(() => execute("!!document.querySelector('#review-filter')"), 'central Review opens')
  await execute(
    "(()=>{const select=document.querySelector('#review-filter');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'all');select.dispatchEvent(new Event('change',{bubbles:true}));})()"
  )
  // The main smoke already saved one of the nine clear categories manually.
  const initial = (await call('classificationState')) as ClassificationState
  if (initial.ready !== 8 || initial.unresolved !== 5)
    throw new Error(`Unexpected automatic fixture results: ${JSON.stringify(initial)}`)
  const original = tracks.find(t => t.genre === 'Reggaeton' && t.year === 2007)!,
    remix = tracks.find(t => t.genre === 'Reggaeton' && t.title?.includes('Remix'))!
  async function confirm(track: Track, year: number, kind: 'recording' | 'version') {
    await wait(
      () => execute(`!!document.querySelector('[data-track-id="${track.id}"]')`),
      'track visible in Review'
    )
    await execute(
      `document.querySelector('[data-track-id="${track.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
    )
    await wait(
      async () =>
        Boolean(await execute('!!document.querySelector(\'[aria-label="Confirmed era year"]\')')),
      'era confirmation form'
    )
    await execute(
      `(()=>{const input=document.querySelector('[aria-label="Confirmed era year"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(String(year))});input.dispatchEvent(new Event('input',{bubbles:true}));const select=document.querySelector('.era-form select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(kind)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`
    )
    await wait(
      async () =>
        Boolean(
          await execute(
            "!!document.querySelector('.era-form button[type=submit]') && !document.querySelector('.era-form button[type=submit]').disabled"
          )
        ),
      'confirm enabled'
    )
    await execute("document.querySelector('.era-form button[type=submit]').click()")
    await wait(
      async () =>
        (await call('get', track.id)).category ===
        (year <= 2007 ? 'Reggaeton Old' : 'Reggaeton New'),
      'era suggestion saved'
    )
    await idle()
  }
  await confirm(original, 2007, 'recording')
  await confirm(remix, 2008, 'version')
  const bachata = tracks.find(t => t.genre === 'Bachata')!
  await execute(
    "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Settings & sources').click()"
  )
  await wait(
    () => execute("!!document.querySelector('#classification-settings')"),
    'classification settings entry displayed'
  )
  await execute("document.querySelector('#classification-settings').click()")
  await wait(
    async () => Boolean(await execute("!!document.querySelector('.rule-form')")),
    'rules dialog'
  )
  await execute(
    "(()=>{const input=document.querySelector('[aria-label=\"Rule match\"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Bachata');input.dispatchEvent(new Event('input',{bubbles:true}));})()"
  )
  await wait(
    async () =>
      Boolean(await execute("!document.querySelector('.rule-form button[type=submit]').disabled")),
    'preview enabled'
  )
  await execute("document.querySelector('.rule-form button[type=submit]').click()")
  await wait(
    async () => Boolean(await execute("!!document.querySelector('.rule-preview')")),
    'preview visible'
  )
  await execute(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'
  )
  // Preview a real matching category change before applying the explicit rule.
  await writeFile(
    path.join(profile, 'classification-rules.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  await execute("document.querySelector('.rule-preview button').click()")
  await wait(async () => (await call('classificationRules')).length === 1, 'previewed rule saved')
  await idle()
  if ((await call('get', bachata.id)).category !== 'Jersey Club')
    throw new Error('Saved rule did not update its matching suggestion.')
  await wait(
    async () =>
      await execute(
        '!!document.querySelector(\'[aria-label="Remove rule Bachata"]\') && !document.querySelector(\'[aria-label="Remove rule Bachata"]\').disabled'
      ),
    'saved rule visible and enabled'
  )
  await execute('document.querySelector(\'[aria-label="Remove rule Bachata"]\').click()')
  await wait(async () => (await call('classificationRules')).length === 0, 'rule removal saved')
  await idle()
  if ((await call('get', bachata.id)).category !== 'Bachata')
    throw new Error('Removing the rule did not restore the default suggestion.')
  await wait(
    async () => await execute("!document.querySelector('.classification-toggle input').disabled"),
    'automatic controls enabled'
  )
  const automatic = await execute("document.querySelector('.classification-toggle input').checked")
  await execute("document.querySelector('.classification-toggle input').click()")
  await wait(async () => !(await call('classificationState')).automatic, 'automatic pause')
  await wait(
    async () =>
      await execute(
        "!document.querySelector('.classification-toggle input').checked && !document.querySelector('.classification-toggle input').disabled"
      ),
    'pause visible in controls'
  )
  await execute("document.querySelector('.classification-toggle input').click()")
  await wait(
    async () => (await call('classificationState')).automatic,
    'automatic resume persisted'
  )
  await idle()
  const invalidRuleRejected = await execute(
    "window.organizer.classificationRulePreview({field:'genre',match:'Test',category:'_JUNK'}).then(()=>false,()=>true)"
  )
  const invalidYearRejected = await execute(
    `window.organizer.eraYear(${JSON.stringify(original.id)},0,9999,'recording','').then(()=>false,()=>true)`
  )
  await execute("document.querySelector('.modal-close').click()")
  await wait(async () => !(await execute("!!document.querySelector('.modal')")), 'dialog dismissed')
  await execute(
    `document.querySelector('[data-track-id="${remix.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
  )
  await wait(
    async () =>
      Boolean(
        await execute(
          "document.querySelector('.classification-evidence')?.innerText.includes('Reggaeton New')"
        )
      ),
    'explanation visible'
  )
  await execute("document.querySelector('.classification-evidence details').open=true")
  if (!(await call('classificationState')).automatic)
    throw new Error('Automatic classification did not remain enabled after closing settings.')
  await execute(
    "document.querySelector('.classification-evidence').scrollIntoView({block:'start'})"
  )
  await execute(
    'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'
  )
  await writeFile(
    path.join(profile, 'classification-evidence.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  const after = await call('get', original.id),
    afterRemix = await call('get', remix.id)
  if (after.year !== 2007 || afterRemix.year !== 2024 || after.manual || afterRemix.manual)
    throw new Error('Automatic classification overwrote original tags or became a manual approval.')
  return {
    automaticOn: automatic,
    initialReady: initial.ready,
    initialUnresolved: initial.unresolved,
    original2007: after.category,
    remix2008: afterRemix.category,
    originalTagsPreserved: true,
    suggestionsUnapproved: true,
    rulePreviewSaveRemove: true,
    pauseResume: true,
    explanationVisible: true,
    invalidRuleRejected,
    invalidYearRejected,
  }
}

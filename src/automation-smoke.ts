import type { BrowserWindow } from 'electron'
import { dialog } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parser } from 'sax'
// Isolated synthetic profile only; real renderer/IPC/service and native XML validation.
export async function automationSmoke(
  win: BrowserWindow,
  call: (method: string, args?: unknown) => Promise<any>,
  profile: string
) {
  const execute = (code: string) => win.webContents.executeJavaScript(code)
  const wait = async (test: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (await test()) return
      await new Promise(r => setTimeout(r, 80))
    }
    throw new Error(`Automation smoke: ${label}`)
  }
  await execute(
    "[...document.querySelectorAll('button')].find(b=>b.textContent===' Settings & sources' || b.textContent.trim()==='Settings & sources').click()"
  )
  await wait(
    () => execute("!!document.querySelector('.automation-settings input')"),
    'settings visible'
  )
  const initial = await call('automationState')
  if (initial.config.enabled) throw new Error('New profiles must opt in')
  const pathRejected = await execute(
    "window.organizer.automationConfigure({enabled:true,sourceIds:[],autoApprove:true,syncEnabled:true,watchRekordbox:false,syncDirectory:'/tmp/unapproved'}).then(()=>false,()=>true)"
  )
  if (!pathRejected) throw new Error('Arbitrary sync path accepted')
  const parent = path.join(profile, 'automatic-playlists')
  await mkdir(parent)
  const original = dialog.showOpenDialog
  try {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [parent],
    })) as typeof dialog.showOpenDialog
    await execute(
      "[...document.querySelectorAll('.automation-settings button')].find(b=>b.textContent==='Choose sync folder').click()"
    )
    await wait(
      async () => Boolean((await call('automationState')).config.syncDirectory),
      'native folder boundary'
    )
  } finally {
    dialog.showOpenDialog = original
  }
  await execute(
    "[...document.querySelectorAll('.automation-option')].find(l=>l.textContent.includes('Keep my Rekordbox XML')).querySelector('input').click()"
  )
  await new Promise(r => setTimeout(r, 100))
  await execute(
    "[...document.querySelectorAll('.automation-settings button')].find(b=>b.textContent==='Save & start automatic handling').click()"
  )
  await wait(async () => {
    const s = await call('automationState')
    if (s.error) throw new Error(s.error)
    return !!s.sync && !s.running
  }, 'generated XML')
  const state = await call('automationState')
  const xml = await readFile(state.sync.xmlPath, 'utf8')
  if (!xml.includes('DJ Library Organizer')) throw new Error('Missing stable namespace')
  const playlistNames = new Set<string>()
  const parsed = parser(true)
  parsed.onopentag = node => {
    if (node.name === 'NODE') playlistNames.add(String(node.attributes.Name))
  }
  parsed.write(xml).close()
  const organization = await call('organizationState')
  if (
    !playlistNames.has('Practice Library') ||
    !playlistNames.has('All Practice Tracks') ||
    !playlistNames.has('Genres') ||
    !playlistNames.has('Prepared playlists') ||
    state.sync.practiceTracks !== organization.practiceCount
  )
    throw new Error('Managed XML does not contain the complete practice library')
  if (
    !organization.tags
      .filter((tag: { group: string }) => tag.group === 'genre')
      .every((tag: { value: string }) => playlistNames.has(tag.value))
  )
    throw new Error('Managed XML genre labels differ from the practice sidebar')
  await wait(
    () =>
      execute(
        "document.querySelector('.automation-settings').innerText.includes('Refresh/import it in Rekordbox')"
      ),
    'honest sync status'
  )
  await wait(
    () =>
      execute(
        `document.querySelector('.automation-settings').innerText.includes('${state.sync.practiceTracks} practice tracks')`
      ),
    'practice track status'
  )
  await execute("document.querySelector('.automation-settings').scrollIntoView({block:'start'})")
  await writeFile(
    path.join(profile, 'automation-settings.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  await execute(
    "[...document.querySelectorAll('.automation-settings button')].find(b=>b.textContent==='Pause automatic handling').click()"
  )
  await wait(async () => !(await call('automationState')).active, 'pause')
  await execute("document.querySelector('.modal-close').click()")
  return {
    defaultOff: true,
    pathRejected,
    folderChosen: true,
    xmlPublished: true,
    practiceLibraryXML: true,
    allPracticeAvailable: true,
    newGenreLabels: true,
    tracks: state.sync.tracks,
    pauseWorks: true,
    liveSyncNotClaimed: true,
  }
}

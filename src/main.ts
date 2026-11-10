import { trackTrashUISmoke } from './track-trash-ui-smoke'
import { randomUUID } from 'node:crypto'
import { organizationSmoke } from './organization-smoke'
import { automationSmoke } from './automation-smoke'
import type { AutomationState } from './automation-types'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  utilityProcess,
  type UtilityProcess,
} from 'electron'
import path from 'node:path'
import { realpath, mkdir, writeFile, lstat, rename, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { requestSchemas, type Playback, type Source, type Track } from './shared'
import packageInfo from '../package.json'
import { removeRetiredResearchKey } from './research-retirement'
import { NativeHelper } from './native'
import { researchSmoke } from './research-smoke'
import { classificationSmoke } from './classification-smoke'
import { preparationSmoke } from './preparation-smoke'
import { xmlSmoke } from './xml-smoke'
import { physicalKey, within } from './scanner'

const projectRoot = path.resolve(__dirname, '..')
const uiFile = path.join(__dirname, 'ui', 'index.html')
const trustedURL = pathToFileURL(uiFile).href
const profileArgument = process.argv.find(a => a.startsWith('--test-profile='))
const smokeArgument = process.argv.find(a => a.startsWith('--smoke-report='))
// Maintenance launches can display an updated catalog without starting a scan.
const skipStartupScan = process.argv.includes('--skip-startup-scan')
if (smokeArgument && !profileArgument)
  throw new Error('Smoke checks require a separate --test-profile.')
// Local test runner only; never exposed through IPC or persisted as a source root.
if (profileArgument)
  app.setPath('userData', path.resolve(profileArgument.slice('--test-profile='.length)))
app.setName('DJ Library Organizer')
if (!app.requestSingleInstanceLock()) app.exit(0)
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
})
let win: BrowserWindow | null = null
let service: UtilityProcess
let preview: NativeHelper
let closing = false
let next = 0
const pending = new Map<
  number,
  {
    resolve: (v: any) => void
    reject: (e: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
>()
let readyResolve: () => void
let readyReject: (e: Error) => void
const ready = new Promise<void>((resolve, reject) => {
  readyResolve = resolve
  readyReject = reject
})
void ready.catch(() => {})
function call<T = any>(method: string, args?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(
      () => {
        pending.delete(id)
        reject(
          new Error('The library service is taking too long. Restart the app if this continues.')
        )
      },
      method === 'preparationExport' ||
        method === 'trackTrashPreviewJunk' ||
        method === 'trackTrashStart'
        ? 1800000
        : method.startsWith('preparation') ||
            method.startsWith('duplicate') ||
            method.startsWith('cleanup') ||
            method.startsWith('organization') ||
            method.startsWith('trackTrash') ||
            method === 'trashRestoreFiles' ||
            method === 'libraryReviewOverview' ||
            method.startsWith('xml') ||
            method === 'classificationRulePreview'
          ? 180000
          : 30000
    )
    pending.set(id, { resolve, reject, timer })
    service.postMessage({ id, method, args })
  })
}
async function authorizedFile(id: string): Promise<Track> {
  const track = await call<Track | undefined>('get', id)
  if (!track) throw new Error('Track not found.')
  const sources = await call<Source[]>('sources')
  const actual = await realpath(track.path)
  if (!sources.some(s => s.enabled && within(s.path, actual)))
    throw new Error('This track is outside the authorized source folders.')
  const info = await preview.inspect(track.path)
  if (!info.regular || info.alias || info.cloudOnly || info.availabilityUnknown)
    throw new Error('This file is unavailable locally. Its contents were not opened.')
  if (physicalKey(info) !== (track as Track & { physicalKey: string }).physicalKey)
    throw new Error('A different file now occupies this path. Run Smart Scan before previewing it.')
  return track
}
async function chooseSource(home: boolean) {
  const result = await dialog.showOpenDialog(win!, {
    title: home
      ? 'Discover My Music — choose your home folder or another broad source'
      : 'Add a source folder',
    message:
      'Read-only discovery. Desktop, Downloads, Documents, Music and nested folders are included when accessible. Bundles, caches, Trash, backups and cloud-only audio are skipped. macOS may request additional folder access. This never authorizes music changes.',
    defaultPath: app.getPath('home'),
    properties: ['openDirectory', 'multiSelections', 'dontAddToRecent'],
  })
  if (result.canceled) return false
  const sources: Source[] = []
  for (const chosen of result.filePaths) {
    const actual = await realpath(chosen)
    const info = await preview.inspect(actual)
    if (!info.directory || info.package || info.alias || info.cloudOnly || info.availabilityUnknown)
      throw new Error(
        'Choose a locally available ordinary folder. Managed libraries and bundles are excluded.'
      )
    sources.push(
      await call('addSource', {
        path: actual,
        demo: false,
        broad: actual === app.getPath('home'),
      })
    )
  }
  win?.webContents.send('organizer:change', { kind: 'sources' })
  return call('scan', { kind: 'discovery', sources })
}
const actions: Record<string, (args: any) => Promise<unknown>> = {
  automationState: () => call('automationState'),
  automationConfigure: options => call('automationConfigure', options),
  automationCheck: () => call('automationCheck'),
  automationReveal: async () => {
    const state = await call<AutomationState>('automationState')
    if (state.sync) shell.showItemInFolder(state.sync.xmlPath)
    else if (state.config.syncDirectory) shell.showItemInFolder(state.config.syncDirectory)
  },
  automationFolder: async () => {
    const result = await dialog.showOpenDialog(win!, {
      title: 'Choose where to keep Rekordbox sync playlists',
      message:
        'The app creates a DJ Library Organizer Sync folder here and updates its XML while open. Choose a folder outside your audio sources.',
      defaultPath: app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    })
    if (result.canceled) return null
    return call('automationFolder', await realpath(result.filePaths[0]!))
  },

  duplicateMembers: args => call('duplicateMembers', args),
  duplicateAutoChoose: options => call('duplicateAutoChoose', options),
  cleanupPreview: options => call('cleanupPreview', options),
  cleanupStart: async token => {
    await preview.call('pause')
    return call('cleanupStart', token)
  },
  cleanupState: () => call('cleanupState'),
  cleanupHistory: () => call('cleanupHistory'),
  cleanupPause: () => call('cleanupPause'),
  cleanupRestore: id => call('cleanupRestore', id),
  duplicateState: () => call('duplicateState'),
  duplicateRun: () => call('duplicateRun'),
  duplicatePause: () => call('duplicatePause'),
  duplicateList: offset => call('duplicateList', offset),
  duplicateResolve: args => call('duplicateResolve', args),
  preparationPreview: args => call('preparationPreview', args),
  preparationPage: args => call('preparationPage', args),
  preparationClassify: args => call('preparationClassify', args),
  preparationApprove: token => call('preparationApprove', token),
  preparationCancel: () => call('preparationCancel'),
  preparationHistory: () => call('preparationHistory'),
  preparationImported: id => call('preparationImported', id),
  preparationVerify: id => call('preparationVerify', id),
  preparationReveal: async id => {
    const history = await call('preparationHistory')
    const record = history.find((r: { id: string }) => r.id === id)
    if (!record) throw new Error('Export not found.')
    shell.showItemInFolder(record.directory)
  },
  preparationExport: async token => {
    const result = await dialog.showOpenDialog(win!, {
      title: 'Save prepared playlists',
      message:
        'Choose a folder for a new export batch containing rekordbox XML, M3U8 playlists and import instructions. Your music stays in place.',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    })
    if (result.canceled) return null
    return call('preparationExport', {
      token,
      parent: await realpath(result.filePaths[0]!),
      version: packageInfo.version,
    })
  },
  organizationState: () => call('organizationState'),
  organizationRun: () => call('organizationRun'),
  organizationTrack: id => call('organizationTrack', id),
  organizationTagsUpdate: args => call('organizationTagsUpdate', args),
  organizationFamiliarity: args => call('organizationFamiliarity', args),
  playlistCreate: args => call('playlistCreate', args),
  playlistRename: args => call('playlistRename', args),
  playlistDelete: id => call('playlistDelete', id),
  playlistMembers: args => call('playlistMembers', args),
  playlistExport: async id => {
    const data = await call<{
      name: string
      body: string
      tracks: number
      unavailable: number
    }>('playlistExportData', id)
    const result = await dialog.showSaveDialog(win!, {
      title: 'Export playlist for Rekordbox',
      defaultPath: path.join(
        app.getPath('documents'),
        data.name.replace(/[^\p{L}\p{N} _-]/gu, '_') + '.m3u8'
      ),
      filters: [{ name: 'M3U8 playlist', extensions: ['m3u8'] }],
    })
    if (result.canceled || !result.filePath) return null
    const parent = await realpath(path.dirname(result.filePath))
    const roots = await call<Source[]>('sources')
    if (roots.some(root => within(root.path, parent)))
      throw new Error('Save playlist exports outside your music source folders.')
    if (!result.filePath.toLowerCase().endsWith('.m3u8'))
      throw new Error('Save this playlist with the .m3u8 extension.')
    const destination = path.join(parent, path.basename(result.filePath))
    const original = await lstat(destination).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (original && (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1))
      throw new Error('Choose a regular playlist file for replacement.')
    const temporary = destination + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporary, data.body, { flag: 'wx', mode: 0o600 })
      const current = await lstat(destination).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (
        original
          ? !current ||
            current.dev !== original.dev ||
            current.ino !== original.ino ||
            current.mtimeMs !== original.mtimeMs
          : current
      )
        throw new Error('The destination changed. Choose the export path again.')
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true })
    }
    return { path: result.filePath, tracks: data.tracks }
  },
  libraryReviewOverview: () => call('libraryReviewOverview'),
  trackTrashPreview: changes => call('trackTrashPreview', changes),
  trackTrashPreviewJunk: () => call('trackTrashPreviewJunk'),
  trackTrashStart: async token => {
    await preview.call('pause')
    return call('trackTrashStart', token)
  },
  trackTrashHistory: () => call('trackTrashHistory'),
  trackTrashRestore: id => call('trackTrashRestore', id),
  trashRestoreFiles: async changes => {
    await preview.call('pause')
    return call('trashRestoreFiles', changes)
  },
  summary: () => call('summary'),
  sources: () => call('sources'),
  list: args => call('list', args),
  discover: () => chooseSource(true),
  addSource: () => chooseSource(false),
  demo: async () => {
    const demoRoot = app.isPackaged
      ? path.join(process.resourcesPath, 'demo-library')
      : path.join(projectRoot, 'dist', 'demo-library')
    const source = await call('addSource', {
      path: await realpath(demoRoot),
      demo: true,
      broad: false,
    })
    win?.webContents.send('organizer:change', { kind: 'sources' })
    return call('scan', { kind: 'discovery', sources: [source] })
  },
  scan: kind => call('scan', { kind }),
  cancelScan: () => call('cancelScan'),
  sourceEnabled: args => call('sourceEnabled', args),
  xmlChoose: async kind => {
    const snapshot = kind === 'refresh' ? await call('xmlSummary') : null
    const result = await dialog.showOpenDialog(win!, {
      title:
        kind === 'folder'
          ? 'Choose a folder containing rekordbox XML'
          : kind === 'refresh'
            ? 'Refresh Rekordbox Library — choose a fresh export'
            : 'Choose your rekordbox XML export',
      defaultPath: snapshot?.sourcePath || app.getPath('downloads'),
      message:
        'The XML is copied into a private local snapshot. Your export and audio are read-only. Select the candidate you want to import.',
      properties: [
        kind === 'folder' ? 'openDirectory' : 'openFile',
        'multiSelections',
        'dontAddToRecent',
      ],
      ...(kind === 'folder' ? {} : { filters: [{ name: 'rekordbox XML', extensions: ['xml'] }] }),
    })
    return result.canceled ? { candidates: [], warnings: [] } : call('xmlFind', result.filePaths)
  },
  xmlDrop: args => call('xmlFind', args),
  xmlImport: id => call('xmlImport', id),
  xmlCancel: () => call('xmlCancel'),
  xmlSummary: () => call('xmlSummary'),
  xmlList: q => call('xmlList', q),
  xmlTrack: id => call('xmlTrack', id),
  researchImportChoose: async () => {
    if (profileArgument && smokeArgument)
      return call('researchImportFile', path.join(app.getPath('userData'), 'research-import.json'))
    const chosen = await dialog.showOpenDialog(win!, {
      title: 'Import researched genre and year',
      properties: ['openFile'],
      filters: [{ name: 'Research bundle', extensions: ['json'] }],
    })
    if (chosen.canceled || !chosen.filePaths[0]) return null
    return call('researchImportFile', chosen.filePaths[0])
  },
  researchImportApply: token => call('researchImportApply', token),
  researchState: () => call('researchState'),
  researchPreview: args => call('researchPreview', args),
  researchStart: token => call('researchStart', token),
  researchPause: () => call('researchPause'),
  researchTrack: id => call('researchTrack', id),
  researchAccept: args => call('researchAccept', args),
  researchClear: args => call('researchClear', args),
  researchSource: async args => {
    const url = await call('researchSource', args)
    await shell.openExternal(url)
  },
  classificationState: () => call('classificationState'),
  classificationRun: () => call('classificationRun'),
  classificationAutomatic: enabled => call('classificationAutomatic', enabled),
  classificationTrack: id => call('classificationTrack', id),
  classificationRules: () => call('classificationRules'),
  classificationRulePreview: rule => call('classificationRulePreview', rule),
  classificationRuleCancel: () => call('classificationRuleCancel'),
  classificationRuleSave: token => call('classificationRuleSave', token),
  classificationRuleRemove: id => call('classificationRuleRemove', id),
  eraYear: args => call('eraYear', args),
  classify: args => call('classify', args),
  review: args => call('review', args),
  reveal: async id => {
    const track = await authorizedFile(id)
    shell.showItemInFolder(track.path)
  },
  playback: async args => {
    if (args.action === 'load') {
      if (!args.id) throw new Error('Choose a track to preview.')
      const track = await authorizedFile(args.id)
      try {
        const value = await preview.call<Playback>('load', {
          path: track.path,
          fileId: track.id,
        })
        if (value.error)
          await call('previewEvidence', {
            id: track.id,
            status: 'failed',
            error: value.error,
          })
        return value
      } catch (e) {
        await call('previewEvidence', {
          id: track.id,
          status: 'failed',
          error: e instanceof Error ? e.message : 'Preview failed.',
        })
        throw e
      }
    }
    if (args.action === 'volume' && (args.value === undefined || args.value > 1))
      throw new Error('Volume must be between 0 and 1.')
    const value = await preview.call<Playback>(
      args.action,
      args.value === undefined ? {} : { value: args.value }
    )
    if (args.action === 'play' && value.playing && value.fileId)
      await call('previewEvidence', {
        id: value.fileId,
        status: 'played',
        error: null,
      })
    return value
  },
}
ipcMain.handle('organizer:request', async (event, method: unknown, args: unknown) => {
  try {
    if (
      !win ||
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame.url !== trustedURL
    )
      throw new Error('Unauthorized application frame.')
    if (typeof method !== 'string' || !Object.hasOwn(requestSchemas, method))
      throw new Error('Unsupported command.')
    const schema = requestSchemas[method as keyof typeof requestSchemas]
    const validated = schema.parse(args)
    await ready
    const value = await actions[method]!(validated)
    return { ok: true, value }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'The operation could not be completed.',
    }
  }
})

async function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#101114',
    title: 'DJ Library Organizer',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== trustedURL) e.preventDefault()
  })
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false)
  )
  win.webContents.session.setPermissionCheckHandler(() => false)
  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => callback({ cancel: true })
  )
  await win.loadFile(uiFile)
  if (smokeArgument) {
    await ready
    const before = await win.webContents.executeJavaScript(
      "({title:document.title,bridge:typeof window.organizer,rows:document.querySelectorAll('tbody tr').length,body:document.body.innerText,unsafe:typeof window.require})"
    )
    await actions.demo!(undefined)
    let summary = await call('summary')
    const deadline = Date.now() + 60000
    while (summary.lastScan?.status === 'running' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300))
      summary = await call('summary')
    }
    const list = await call('list', {
      search: '',
      view: 'all',
      sort: 'artist',
      direction: 'asc',
      offset: 0,
      limit: 100,
    })
    const track = list.tracks.find((t: Track) => t.availability === 'available')
    let playback: unknown = null
    if (track) {
      playback = await actions.playback!({ action: 'load', id: track.id })
      await actions.playback!({ action: 'play' })
      await new Promise(r => setTimeout(r, 150))
      playback = await actions.playback!({ action: 'status' })
      await actions.playback!({ action: 'pause' })
    }
    const runtime = await win.webContents.executeJavaScript('window.organizer.runtimeSecurity')
    const security = {
      ...runtime,
      nodeIntegration: before.unsafe !== 'undefined',
    }
    await new Promise(r => setTimeout(r, 500))
    if (!track) throw new Error('Demo audio was not discovered.')
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-track-id="${track.id}"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))`
    )
    await new Promise(r => setTimeout(r, 150))
    await win.webContents.executeJavaScript(
      "(()=>{const input=document.querySelector('#organization-tag-value');if(!input)throw new Error('Track selection did not reach the tag panel.');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Jersey Club');input.dispatchEvent(new Event('input',{bubbles:true}));})()"
    )
    await new Promise(r => setTimeout(r, 100))
    await win.webContents.executeJavaScript(
      "document.querySelector('#organization-tag-add')?.click()"
    )
    let classified = await call<Track>('get', track.id)
    const saveDeadline = Date.now() + 5000
    while (classified.category !== 'Jersey Club' && Date.now() < saveDeadline) {
      await new Promise(r => setTimeout(r, 100))
      classified = await call('get', track.id)
    }
    if (classified.category !== 'Jersey Club') throw new Error('UI classification did not persist.')
    const invalidQueryRejected = await win.webContents.executeJavaScript(
      "window.organizer.list({search:'',view:'all',sort:'artist',direction:'asc',offset:0,limit:1000000}).then(()=>false,()=>true)"
    )
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-track-id="${track.id}"]')?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`
    )
    const previewDeadline = Date.now() + 5000
    playback = await actions.playback!({ action: 'status' })
    while (!(playback as Playback).playing && Date.now() < previewDeadline) {
      await new Promise(r => setTimeout(r, 100))
      playback = await actions.playback!({ action: 'status' })
    }
    if (!(playback as Playback).playing) throw new Error('UI audio preview did not start.')
    await win.webContents.executeJavaScript(
      'document.querySelector(\'[aria-label="Pause preview"]\')?.click()'
    )
    await new Promise(r => setTimeout(r, 400))
    const automaticClassification = await classificationSmoke(
      win,
      call,
      app.getPath('userData'),
      list.tracks
    )
    const research = await researchSmoke(win, call, app.getPath('userData'), list.tracks)
    const xml = await xmlSmoke(win, call, app.getPath('userData'), list.tracks)
    const preparation = await preparationSmoke(win, call, app.getPath('userData'))
    const automation = await automationSmoke(win, call, app.getPath('userData'))
    const organization = await organizationSmoke(win, call, app.getPath('userData'))
    const trackTrash = await trackTrashUISmoke(win, call, app.getPath('userData'))
    summary = await call('summary')
    const after = await win.webContents.executeJavaScript(
      "({rows:document.querySelectorAll('tbody tr[data-track-id]').length,selected:document.querySelectorAll('tr[aria-selected=true]').length,body:document.body.innerText})"
    )
    const { writeFile } = await import('node:fs/promises')
    const reportPath = path.resolve(smokeArgument.slice('--smoke-report='.length))
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          before,
          after,
          security,
          summary,
          classification: classified.category,
          invalidQueryRejected,
          automaticClassification,
          organization,
          trackTrash,
          automation,
          research,
          preparation,
          xml,
          listCount: list.total,
          playback,
          metrics: app.getAppMetrics(),
        },
        null,
        2
      )
    )
    await win.webContents.executeJavaScript(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))'
    )
    const screenshot = await win.webContents.capturePage()
    await writeFile(reportPath.replace(/\.json$/, '.png'), screenshot.toPNG())
    app.quit()
  }
}
app
  .whenReady()
  .then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 })
    const executable = app.isPackaged
      ? path.join(process.resourcesPath, 'native', 'organizer-helper')
      : path.join(__dirname, 'native', 'organizer-helper')
    preview = new NativeHelper(executable)
    await removeRetiredResearchKey(app.getPath('userData'))
    service = utilityProcess.fork(
      path.join(__dirname, 'service.cjs'),
      [
        app.getPath('userData'),
        executable,
        profileArgument && smokeArgument ? 'synthetic-research' : '',
        packageInfo.version,
      ],
      { serviceName: 'DJ Library — read-only indexer', stdio: 'pipe' }
    )
    service.on('message', m => {
      if (m.ready) {
        readyResolve()
        return
      }
      if (m.event) {
        win?.webContents.send('organizer:change', m.event)
        return
      }
      const p = pending.get(m.id)
      if (p) {
        clearTimeout(p.timer)
        pending.delete(m.id)
        m.ok ? p.resolve(m.value) : p.reject(new Error(m.error))
      }
    })
    service.stderr?.on('data', data => process.stderr.write(data))
    service.on('exit', code => {
      readyReject(new Error(`Library service stopped (${code}). Restart the app.`))
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(`Library service stopped (${code}). Restart the app.`))
      }
      pending.clear()
    })
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'DJ Library Organizer',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { role: 'togglefullscreen' },
          ],
        },
        { role: 'windowMenu' },
      ])
    )
    await createWindow()
    if (!smokeArgument && !skipStartupScan) {
      await ready
      const sources = await call<Source[]>('sources')
      const automatic = await call<AutomationState>('automationState')
      if (automatic.config.enabled) await call('automationStart')
      else if (sources.some(s => s.enabled)) await call('scan', { kind: 'smart' })
    }
  })
  .catch(async error => {
    console.error(error)
    if (smokeArgument) app.exit(1)
    else {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Could not open the library',
        message: error.message,
        detail: 'Your music has not been modified. Keep the app database for recovery.',
      })
      app.quit()
    }
  })
app.on('before-quit', event => {
  if (closing || !service) return
  event.preventDefault()
  closing = true
  void call('shutdown')
    .catch(() => {})
    .finally(() => {
      preview?.close()
      service?.kill()
      app.quit()
    })
})
app.on('window-all-closed', () => app.quit())

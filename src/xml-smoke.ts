// Invoked only by the explicit smoke runner with a separate test profile.
import type { BrowserWindow } from 'electron'
import { dialog } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Track, XMLSummary } from './shared'
export async function xmlSmoke(
  win: BrowserWindow,
  call: (method: string, args?: unknown) => Promise<any>,
  profile: string,
  tracks: Track[]
) {
  const folder = path.join(profile, 'generated-xml')
  await mkdir(folder, { recursive: true })
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const xml = `<?xml version="1.0" encoding="UTF-8"?><DJ_PLAYLISTS Version="1.0.0"><PRODUCT Name="rekordbox" Version="7.synthetic"/><COLLECTION Entries="3">${tracks
    .slice(0, 2)
    .map(
      (t, i) =>
        `<TRACK TrackID="${i + 1}" Location="${escape(pathToFileURL(t.path).href)}" Name="${escape(t.title || t.filename)}" Artist="${escape(t.artist || '')}" Size="${t.size}"><TEMPO Inizio="0" Bpm="128" Metro="4/4" Battito="1"/><POSITION_MARK Name="Intro" Type="0" Start="0.2" Num="0"/></TRACK>`
    )
    .join(
      ''
    )}<TRACK TrackID="3" Name="Not discovered" Location="file:///generated-only/unmatched.wav"/></COLLECTION><PLAYLISTS><NODE Type="0" Name="ROOT" Count="1"><NODE Type="0" Name="Synthetic sets" Count="1"><NODE Type="1" Name="Demo preparation" KeyType="0" Entries="2"><TRACK Key="1"/><TRACK Key="2"/></NODE></NODE></NODE></PLAYLISTS></DJ_PLAYLISTS>`
  const first = path.join(folder, 'snapshot-a.xml'),
    second = path.join(folder, 'snapshot-b.xml'),
    invalid = path.join(folder, 'invalid.xml')
  await writeFile(first, xml)
  await writeFile(second, xml)
  await writeFile(invalid, '<foreign/>')
  const execute = (code: string) => win.webContents.executeJavaScript(code)
  const wait = async (condition: string) => {
    const end = Date.now() + 10000
    while (Date.now() < end) {
      if (await execute(condition)) return
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error(
      `XML UI timed out: ${condition}; UI: ${(await execute("document.querySelector('.xml-connection')?.innerText || document.body.innerText")).slice(-2000)}`
    )
  }
  await execute(
    "[...document.querySelectorAll('.sidebar-footer button')].find(b=>b.textContent.includes('Refresh Rekordbox Library')).click()"
  )
  await wait("!!document.querySelector('.xml-drop')")
  const forgedDropRejected = await execute(
    "window.organizer.xmlDrop([new File(['<foreign/>'],'fake.xml')]).then(()=>false,()=>true)"
  )
  await execute(
    "(()=>{const input=document.createElement('input');input.type='file';input.id='smoke-native-file';input.hidden=true;document.body.append(input);})()"
  )
  win.webContents.debugger.attach('1.3')
  async function drop(files: string[]) {
    const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument')
    const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#smoke-native-file',
    })
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
      nodeId,
      files,
    })
    await execute(
      "(()=>{const data=new DataTransfer();for(const file of document.querySelector('#smoke-native-file').files)data.items.add(file);document.querySelector('.xml-drop').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));})()"
    )
  }
  try {
    await drop([first])
    await wait(
      "document.querySelectorAll('.xml-candidate').length===1 && !document.querySelector('.xml-candidate input').disabled"
    )
    const onboardingScreenshot = await win.webContents.capturePage()
    await writeFile(path.join(profile, 'xml-onboarding.png'), onboardingScreenshot.toPNG())
    const noSilentImport = await execute("document.querySelector('[data-xml-import]').disabled")
    if (await call('xmlSummary')) throw new Error('XML imported without explicit selection.')
    await drop([folder])
    await wait(
      "document.querySelectorAll('.xml-candidate').length===3 && document.querySelectorAll('.xml-candidate:not(.invalid)').length===2"
    )
    const folderDropCandidates = await execute(
      "document.querySelectorAll('.xml-candidate:not(.invalid)').length"
    )
    await execute("document.querySelector('.xml-candidate:not(.invalid) input').click()")
    await wait("!document.querySelector('[data-xml-import]').disabled")
    await execute("document.querySelector('[data-xml-import]').click()")
    await wait("!!document.querySelector('.xml-snapshot')")
    const snapshot = (await call('xmlSummary')) as XMLSummary
    if (
      snapshot.tracks !== 3 ||
      snapshot.counts.referenced !== 2 ||
      snapshot.counts.unmatched !== 1
    )
      throw new Error('XML UI import produced unexpected matches.')
    await wait("document.querySelectorAll('.xml-entry').length===3")
    await execute(
      "(()=>{const select=document.querySelector('[aria-label=\"Filter XML playlist\"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'3');select.dispatchEvent(new Event('change',{bubbles:true}));})()"
    )
    await wait("document.querySelectorAll('.xml-entry').length===2")
    const originalChoose = dialog.showOpenDialog
    try {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [invalid],
      })) as typeof dialog.showOpenDialog
      await execute("document.querySelector('[data-xml-refresh]').click()")
      await wait("document.querySelectorAll('.xml-candidate.invalid').length===1")
      if ((await call('xmlSummary')).id !== snapshot.id)
        throw new Error('Invalid refresh replaced the current snapshot.')
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [second],
      })) as typeof dialog.showOpenDialog
      await execute("document.querySelector('[data-xml-refresh]').click()")
      await wait(
        "document.querySelectorAll('.xml-candidate').length===1 && !document.querySelector('.xml-candidate input').disabled"
      )
      await execute("document.querySelector('.xml-candidate input').click()")
      await wait("!document.querySelector('[data-xml-import]').disabled")
      await execute("document.querySelector('[data-xml-import]').click()")
      await wait(
        "document.querySelectorAll('.xml-entry').length===3 && !document.querySelector('[data-xml-import]')"
      )
      if ((await call('xmlSummary')).id === snapshot.id)
        throw new Error('Refresh did not activate a new snapshot.')
    } finally {
      dialog.showOpenDialog = originalChoose
    }
    await execute(
      "document.querySelector('.xml-entry').open=true;document.querySelector('.xml-snapshot').scrollIntoView({block:'start'})"
    )
    await new Promise(r => setTimeout(r, 100))
    const screenshot = await win.webContents.capturePage()
    await writeFile(path.join(profile, 'xml-connection.png'), screenshot.toPNG())
    const persisted = await call('get', tracks[0]!.id)
    if (persisted.category !== 'Jersey Club')
      throw new Error('XML import changed the UI classification.')
    return {
      snapshot: await call('xmlSummary'),
      forgedDropRejected,
      noSilentImport,
      folderDropCandidates,
      realDiskFileDrop: true,
      realDiskFolderDrop: true,
      playlistFilter: true,
      invalidRefreshPreserved: true,
      refreshed: true,
      classificationPreserved: true,
    }
  } finally {
    win.webContents.debugger.detach()
    await execute(
      "document.querySelector('#smoke-native-file')?.remove();document.querySelector('.modal-close')?.click()"
    )
  }
}

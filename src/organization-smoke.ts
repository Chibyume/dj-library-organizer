// Explicit generated-fixture profile only. Uses the sandboxed renderer and IPC.
import type { BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Track } from './shared'
import type { LibraryPlaylist, OrganizationState } from './organization-types'

export async function organizationSmoke(
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
    throw new Error(
      `Organization smoke: ${label}; ${(await execute('document.body.innerText')).slice(-2600)}`
    )
  }
  const query = {
    search: '',
    view: 'all',
    sort: 'title',
    direction: 'asc',
    offset: 0,
    limit: 500,
  }
  const input = (selector: string, value: string) =>
    execute(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`
    )
  const choose = (selector: string, value: string) =>
    execute(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('change',{bubbles:true}));})()`
    )
  await call('organizationRun')
  await wait(async () => !(await call('organizationState')).pending, 'automatic tags complete')
  const catalog = (await call('list', query)).tracks as Track[]
  const available = catalog.filter(track => track.availability === 'available')
  const state = (await call('organizationState')) as OrganizationState
  const practice = await call('list', { ...query, view: 'practice' })
  if (practice.total !== available.length || state.practiceCount !== available.length)
    throw new Error('All available files must remain in the practice library.')
  const preview = await call('preparationPreview', { scope: 'all', ids: [] })
  const overview = await call('libraryReviewOverview')
  const held = await call('list', { ...query, view: 'review', value: 'held' })
  if (
    overview.held !== preview.blocked ||
    held.total !== preview.blocked ||
    overview.needsApproval !== preview.needsApproval ||
    JSON.stringify(Object.entries(overview.reasons).sort()) !==
      JSON.stringify(Object.entries(preview.reasons).sort())
  )
    throw new Error('Library Review and Rekordbox preview disagree about held tracks.')
  const candidate = (held.tracks as Track[]).find(track => track.availability === 'available')
  if (!candidate) throw new Error('Need an available held fixture to test practice visibility.')
  const practiceExport = await call('playlistExportData', { view: 'practice' })
  if (
    practiceExport.tracks !== available.length ||
    !practiceExport.body.split('\n').includes(candidate.path) ||
    available.some(track => !practiceExport.body.split('\n').includes(track.path))
  )
    throw new Error('Practice playlist export omitted available or held tracks.')
  await execute("document.querySelector('[data-view=practice]').click()")
  await wait(
    () => execute("document.querySelectorAll('tr[data-track-id]').length >= 2"),
    'practice selection regression fixtures visible'
  )
  const visibleIds = (await execute(
    "[...document.querySelectorAll('tr[data-track-id]')].map(row=>row.dataset.trackId)"
  )) as string[]
  const pair = visibleIds.filter(id => available.some(track => track.id === id)).slice(0, 2)
  if (pair.length !== 2)
    throw new Error('Need two available visible tracks for selection regression.')
  const [firstSelected, lastSelected] = pair
  await execute(
    `document.querySelector('[data-track-id="${firstSelected}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
  )
  await wait(
    () =>
      execute(
        `document.querySelector('.organization-editor')?.dataset.activeTrackId === '${firstSelected}'`
      ),
    'first selected track reaches tag editor'
  )
  await execute(
    `document.querySelector('[data-track-id="${lastSelected}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))`
  )
  await wait(
    () =>
      execute(
        `document.querySelectorAll('tr[aria-selected=true]').length === 2 && document.querySelector('.organization-editor')?.dataset.activeTrackId === '${lastSelected}'`
      ),
    'second selected track reaches tag editor'
  )
  await execute(
    `document.querySelector('[data-track-id="${lastSelected}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))`
  )
  await wait(
    () =>
      execute(
        `document.querySelectorAll('tr[aria-selected=true]').length === 1 && document.querySelector('tr[aria-selected=true]')?.dataset.trackId === '${firstSelected}' && document.querySelector('.organization-editor')?.dataset.activeTrackId === '${firstSelected}'`
      ),
    'deselecting active track restores the remaining selected track editor'
  )
  const remaining = available.find(track => track.id === firstSelected)!
  const activeVisibleLabels = await execute(
    `document.querySelector('.selected-track h2')?.textContent === ${JSON.stringify(remaining.title || remaining.filename)}`
  )
  if (!activeVisibleLabels)
    throw new Error('Track label and tag editor disagree after deselection.')
  await execute(
    `document.querySelector('[data-track-id="${lastSelected}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}));document.querySelector('[data-track-id="${lastSelected}"]').dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true}))`
  )
  await wait(
    () =>
      execute(
        `document.querySelectorAll('tr[aria-selected=true]').length === 1 && document.querySelector('tr[aria-selected=true]')?.dataset.trackId === '${firstSelected}' && document.querySelector('.organization-editor')?.dataset.activeTrackId === '${firstSelected}'`
      ),
    'batched selection changes preserve the remaining active editor'
  )
  await input('input[type="search"]', candidate.filename)
  await wait(
    () => execute(`!!document.querySelector('[data-track-id="${candidate.id}"]')`),
    'held track remains available for practice'
  )
  await input('input[type="search"]', '')
  await wait(
    () => execute("document.querySelectorAll('tr[data-track-id]').length > 1"),
    'practice library search clears'
  )
  await writeFile(
    path.join(profile, 'practice-library.png'),
    (await win.webContents.capturePage()).toPNG()
  )

  async function create(name: string, kind: 'folder' | 'playlist', parentId = '') {
    await execute("document.querySelector('#playlist-new').click()")
    await wait(
      () => execute("!!document.querySelector('#playlist-create-form')"),
      'playlist form opens'
    )
    await input('#playlist-name', name)
    await choose('#playlist-kind', kind)
    if (parentId) await choose('#playlist-parent', parentId)
    await wait(
      () => execute("!document.querySelector('#playlist-create').disabled"),
      'playlist create enabled'
    )
    await execute("document.querySelector('#playlist-create').click()")
    await wait(async () => {
      const current = (await call('organizationState')) as OrganizationState
      return current.playlists.some(playlist => playlist.name === name && playlist.kind === kind)
    }, 'playlist persisted')
    await wait(
      () => execute("!document.querySelector('#playlist-create-form')"),
      'playlist form closes'
    )
    const current = (await call('organizationState')) as OrganizationState
    const created = current.playlists.find(
      playlist => playlist.name === name && playlist.kind === kind
    )!
    await wait(
      () => execute(`!!document.querySelector('[data-playlist-id="${created.id}"]')`),
      'created playlist appears in navigation'
    )
    return created
  }
  const folder = await create('Synthetic practice folder', 'folder')
  const first = await create('Synthetic core practice', 'playlist', folder.id)
  const second = await create('Synthetic try next', 'playlist', folder.id)
  if (first.parentId !== folder.id || second.parentId !== folder.id)
    throw new Error('Custom playlist folder membership was not saved.')

  async function selectCandidate() {
    await execute("document.querySelector('[data-view=practice]').click()")
    await input('input[type="search"]', candidate!.filename)
    await wait(
      () => execute(`!!document.querySelector('[data-track-id="${candidate!.id}"]')`),
      'candidate row displayed'
    )
    await execute(
      `document.querySelector('[data-track-id="${candidate!.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
    )
    await wait(
      () => execute("!!document.querySelector('#playlist-destination')"),
      'selection playlist controls displayed'
    )
  }
  async function add(playlist: LibraryPlaylist) {
    await selectCandidate()
    await choose('#playlist-destination', playlist.id)
    await wait(
      () => execute("!document.querySelector('#playlist-add-selected').disabled"),
      'add selected enabled'
    )
    await execute("document.querySelector('#playlist-add-selected').click()")
    await wait(
      async () =>
        (await call('list', { ...query, view: 'playlist', value: playlist.id })).total === 1,
      'playlist membership saved'
    )
  }
  await add(first)
  await add(second)
  const customExport = await call('playlistExportData', first.id)
  if (customExport.tracks !== 1 || !customExport.body.split('\n').includes(candidate.path))
    throw new Error('Custom playlist export did not preserve its exact membership.')
  let memberships = await call('organizationTrack', candidate.id)
  if (
    !memberships.playlists.some((playlist: LibraryPlaylist) => playlist.id === first.id) ||
    !memberships.playlists.some((playlist: LibraryPlaylist) => playlist.id === second.id)
  )
    throw new Error('One file did not retain membership in both custom playlists.')
  const current = (await call('organizationState')) as OrganizationState
  if (current.playlists.find(playlist => playlist.id === folder.id)?.count !== 1)
    throw new Error('Folder count must count distinct files across its children.')

  await selectCandidate()
  await wait(
    () => execute("!!document.querySelector('#organization-tag-value')"),
    'tag editor displayed'
  )
  await choose('#organization-tag-group', 'use')
  const use = 'Synthetic practice route'
  await input('#organization-tag-value', use)
  await wait(
    () => execute("!document.querySelector('#organization-tag-add').disabled"),
    'use tag enabled'
  )
  await execute("document.querySelector('#organization-tag-add').click()")
  await wait(
    async () =>
      (await call('organizationTrack', candidate.id)).tags.some(
        (tag: { group: string; value: string }) => tag.group === 'use' && tag.value === use
      ),
    'manual use tag saved'
  )
  await input('input[type="search"]', use)
  await new Promise(resolve => setTimeout(resolve, 350))
  await wait(
    () =>
      execute(
        `!!document.querySelector('[data-track-id="${candidate.id}"]') && document.querySelectorAll('tr[data-track-id]').length === 1`
      ),
    'tag search finds the exact file'
  )
  const tagged = await call('list', {
    ...query,
    view: 'practice',
    search: use,
  })
  if (tagged.total !== 1 || tagged.tracks[0].id !== candidate.id)
    throw new Error('Saved local tags are missing from library search.')
  await input('input[type="search"]', '')
  await execute(`document.querySelector('[data-playlist-id="${first.id}"]').click()`)
  await wait(
    () => execute(`!!document.querySelector('[data-track-id="${candidate.id}"]')`),
    'custom playlist opens'
  )
  await execute(
    `document.querySelector('[data-track-id="${candidate.id}"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`
  )
  await wait(
    () =>
      execute(
        "!!document.querySelector('#playlist-remove-selected') && !document.querySelector('#playlist-remove-selected').disabled"
      ),
    'remove selected available'
  )
  await execute("document.querySelector('#playlist-remove-selected').click()")
  await wait(
    async () => (await call('list', { ...query, view: 'playlist', value: first.id })).total === 0,
    'membership removed from one playlist'
  )
  memberships = await call('organizationTrack', candidate.id)
  if (
    !memberships.playlists.some((playlist: LibraryPlaylist) => playlist.id === second.id) ||
    (await call('get', candidate.id)).availability !== 'available'
  )
    throw new Error('Removing playlist membership removed another membership or the audio entry.')
  await execute(`document.querySelector('[data-playlist-id="${folder.id}"]').click()`)
  await wait(
    () => execute(`!!document.querySelector('[data-track-id="${candidate.id}"]')`),
    'folder displays remaining child membership'
  )
  await writeFile(
    path.join(profile, 'custom-playlists.png'),
    (await win.webContents.capturePage()).toPNG()
  )
  const invalidPlaylistRejected = await execute(
    "window.organizer.playlistCreate({name:'',kind:'playlist'}).then(()=>false,()=>true)"
  )
  if (!invalidPlaylistRejected) throw new Error('Invalid playlist IPC was accepted.')
  await execute("document.querySelector('[data-view=practice]').click()")
  return {
    automaticTags: state.taggedCount > 0,
    allAvailablePractice: true,
    heldAvailableForPractice: true,
    allPracticeExport: true,
    customPlaylistExport: true,
    selectionTracksFollowSelection: activeVisibleLabels,
    reviewCountsMatchPreparation: true,
    customFolders: true,
    multiplePlaylistMembership: true,
    distinctFolderCount: true,
    localTagSearch: true,
    removeMembershipKeepsOtherPlaylist: true,
    invalidPlaylistRejected,
  }
}

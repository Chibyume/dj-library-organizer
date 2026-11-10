import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { OrganizerAPI } from './shared'
async function request(method: string, args?: unknown) {
  const r = await ipcRenderer.invoke('organizer:request', method, args)
  if (!r.ok) throw new Error(r.error)
  return r.value
}
const api: OrganizerAPI = {
  automationState: () => request('automationState'),
  automationConfigure: options => request('automationConfigure', options),
  automationFolder: () => request('automationFolder'),
  automationCheck: () => request('automationCheck'),
  automationReveal: () => request('automationReveal'),

  runtimeSecurity: {
    sandbox: process.sandboxed,
    contextIsolation: process.contextIsolated,
  },
  duplicateMembers: (key, fingerprint, offset) =>
    request('duplicateMembers', { key, fingerprint, offset }),
  duplicateAutoChoose: options => request('duplicateAutoChoose', options),
  cleanupPreview: options => request('cleanupPreview', options),
  cleanupStart: token => request('cleanupStart', token),
  cleanupState: () => request('cleanupState'),
  cleanupHistory: () => request('cleanupHistory'),
  cleanupPause: () => request('cleanupPause'),
  cleanupRestore: id => request('cleanupRestore', id),
  duplicateState: () => request('duplicateState'),
  duplicateRun: () => request('duplicateRun'),
  duplicatePause: () => request('duplicatePause'),
  duplicateList: offset => request('duplicateList', offset),
  duplicateResolve: (key, fingerprint, keeper) =>
    request('duplicateResolve', { key, fingerprint, keeper }),
  preparationPreview: args => request('preparationPreview', args),
  preparationPage: (token, offset, filter, reason) =>
    request('preparationPage', { token, offset, filter, reason }),
  preparationClassify: args => request('preparationClassify', args),
  preparationApprove: token => request('preparationApprove', token),
  preparationCancel: () => request('preparationCancel'),
  preparationExport: token => request('preparationExport', token),
  preparationHistory: () => request('preparationHistory'),
  preparationImported: id => request('preparationImported', id),
  preparationVerify: id => request('preparationVerify', id),
  preparationReveal: id => request('preparationReveal', id),
  organizationState: () => request('organizationState'),
  organizationRun: () => request('organizationRun'),
  organizationTrack: id => request('organizationTrack', id),
  organizationTagsUpdate: args => request('organizationTagsUpdate', args),
  organizationFamiliarity: args => request('organizationFamiliarity', args),
  playlistCreate: args => request('playlistCreate', args),
  playlistRename: args => request('playlistRename', args),
  playlistDelete: id => request('playlistDelete', id),
  playlistMembers: args => request('playlistMembers', args),
  playlistExport: id => request('playlistExport', id),
  libraryReviewOverview: () => request('libraryReviewOverview'),
  trackTrashPreview: changes => request('trackTrashPreview', changes),
  trackTrashPreviewJunk: () => request('trackTrashPreviewJunk'),
  trackTrashStart: token => request('trackTrashStart', token),
  trackTrashHistory: () => request('trackTrashHistory'),
  trackTrashRestore: id => request('trackTrashRestore', id),
  trashRestoreFiles: changes => request('trashRestoreFiles', changes),
  summary: () => request('summary'),
  sources: () => request('sources'),
  list: q => request('list', q),
  discover: () => request('discover'),
  addSource: () => request('addSource'),
  demo: () => request('demo'),
  scan: kind => request('scan', kind),
  cancelScan: () => request('cancelScan'),
  sourceEnabled: (id, enabled) => request('sourceEnabled', { id, enabled }),
  xmlChoose: kind => request('xmlChoose', kind),
  xmlDrop: files => {
    if (!Array.isArray(files) || files.length < 1 || files.length > 20)
      return Promise.reject(new Error('Drop up to 20 XML files or folders.'))
    const paths = files.map(file => webUtils.getPathForFile(file))
    if (paths.some(p => !p)) return Promise.reject(new Error('Choose real local files or folders.'))
    return request('xmlDrop', paths)
  },
  xmlImport: id => request('xmlImport', id),
  xmlCancel: () => request('xmlCancel'),
  xmlSummary: () => request('xmlSummary'),
  xmlList: q => request('xmlList', q),
  xmlTrack: id => request('xmlTrack', id),
  researchImportChoose: () => request('researchImportChoose'),
  researchImportApply: token => request('researchImportApply', token),
  researchState: () => request('researchState'),
  researchPreview: args => request('researchPreview', args),
  researchStart: token => request('researchStart', token),
  researchPause: () => request('researchPause'),
  researchTrack: id => request('researchTrack', id),
  researchAccept: (id, revision, resultId, candidate) =>
    request('researchAccept', { id, revision, resultId, candidate }),
  researchClear: (id, revision) => request('researchClear', { id, revision }),
  researchSource: (id, resultId, url) => request('researchSource', { id, resultId, url }),
  classificationState: () => request('classificationState'),
  classificationRun: () => request('classificationRun'),
  classificationAutomatic: enabled => request('classificationAutomatic', enabled),
  classificationTrack: id => request('classificationTrack', id),
  classificationRules: () => request('classificationRules'),
  classificationRulePreview: rule => request('classificationRulePreview', rule),
  classificationRuleCancel: () => request('classificationRuleCancel'),
  classificationRuleSave: token => request('classificationRuleSave', token),
  classificationRuleRemove: id => request('classificationRuleRemove', id),
  eraYear: (id, revision, year, kind, note) =>
    request('eraYear', { id, revision, year, kind, note }),
  classify: (changes, category) => request('classify', { changes, category }),
  review: (changes, action) => request('review', { changes, action }),
  reveal: id => request('reveal', id),
  playback: (action, id, value) =>
    request('playback', {
      action,
      ...(id ? { id } : {}),
      ...(value === undefined ? {} : { value }),
    }),
  onChange: fn => {
    const listener = (_event: unknown, data: unknown) => fn(data as Parameters<typeof fn>[0])
    ipcRenderer.on('organizer:change', listener)
    return () => ipcRenderer.removeListener('organizer:change', listener)
  },
}
contextBridge.exposeInMainWorld('organizer', api)

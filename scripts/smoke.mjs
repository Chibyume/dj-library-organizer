import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
const root = process.cwd()
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const work = path.resolve(root, '../../work')
const profile = path.join(work, 'packaged-smoke-profile')
await rm(profile, { recursive: true, force: true })
await mkdir(profile, { recursive: true })
await writeFile(path.join(profile, 'research-key.encrypted'), 'synthetic opaque retired credential')
const report = path.join(work, 'packaged-smoke.json')
const executable = path.resolve(
  root,
  `../DJ Library Organizer ${pkg.version}.app/Contents/MacOS/DJ Library Organizer`
)
const child = spawn(executable, [`--test-profile=${profile}`, `--smoke-report=${report}`], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
})
const timeout = setTimeout(() => child.kill(), 180000)
const code = await new Promise((resolve, reject) => {
  child.on('error', reject)
  child.on('exit', resolve)
})
clearTimeout(timeout)
if (code !== 0) throw new Error(`Packaged app exited ${code}`)
const data = JSON.parse(await readFile(report, 'utf8'))
if (
  !data.security.sandbox ||
  !data.security.contextIsolation ||
  data.security.nodeIntegration ||
  data.before.unsafe !== 'undefined' ||
  data.summary.files !== 18 ||
  data.after.rows === 0 ||
  data.classification !== 'Jersey Club' ||
  !data.automation?.xmlPublished ||
  !data.automation?.practiceLibraryXML ||
  !data.automation?.allPracticeAvailable ||
  !data.automation?.newGenreLabels ||
  !data.automation?.pathRejected ||
  !data.automation?.pauseWorks ||
  !data.automation?.liveSyncNotClaimed ||
  !data.trackTrash?.explicitPreview ||
  !data.trackTrash?.nativeTrashThroughUI ||
  !data.trackTrash?.nativeRestoreThroughUI ||
  !data.trackTrash?.catalogOnlyOriginalKept ||
  !data.trackTrash?.catalogOnlyHidden ||
  !data.trackTrash?.junkNavigation ||
  !data.trackTrash?.junkAllScopePreview ||
  !data.trackTrash?.junkCancelNoEffects ||
  !data.trackTrash?.junkConfirmed ||
  !data.trackTrash?.junkScopeGuard ||
  !data.trackTrash?.trashLibraryMetadata ||
  !data.trackTrash?.trashLibraryPagination ||
  !data.trackTrash?.trashLibrarySearch ||
  !data.trackTrash?.trashLibrarySafeActions ||
  !data.trackTrash?.trashLibraryRestoreSelected ||
  !data.trackTrash?.restoredBytesUnchanged ||
  !data.trackTrash?.originalDemoUntouched ||
  !data.organization?.automaticTags ||
  !data.organization?.allAvailablePractice ||
  !data.organization?.heldAvailableForPractice ||
  !data.organization?.allPracticeExport ||
  !data.organization?.customPlaylistExport ||
  !data.organization?.selectionTracksFollowSelection ||
  !data.organization?.reviewCountsMatchPreparation ||
  !data.organization?.customFolders ||
  !data.organization?.multiplePlaylistMembership ||
  !data.organization?.localTagSearch ||
  !data.organization?.removeMembershipKeepsOtherPlaylist ||
  !data.organization?.invalidPlaylistRejected ||
  !data.automaticClassification?.automaticOn ||
  !data.automaticClassification?.rulePreviewSaveRemove ||
  !data.automaticClassification?.pauseResume ||
  !data.automaticClassification?.suggestionsUnapproved ||
  !data.automaticClassification?.invalidRuleRejected ||
  !data.automaticClassification?.invalidYearRejected ||
  data.automaticClassification?.original2007 !== 'Reggaeton Old' ||
  data.automaticClassification?.remix2008 !== 'Reggaeton New' ||
  !data.xml?.forgedDropRejected ||
  !data.xml?.realDiskFileDrop ||
  !data.xml?.realDiskFolderDrop ||
  !data.xml?.classificationPreserved ||
  !data.xml?.refreshed ||
  !data.xml?.invalidRefreshPreserved ||
  !data.research?.importedBatch ||
  !data.research?.importPathRejected ||
  !data.research?.sharingPreview ||
  !data.research?.consentGuard ||
  !data.research?.approvalFeedsCategory ||
  !data.research?.tagsPreserved ||
  !data.research?.musicBrainzOnly ||
  !data.research?.noKeyBridge ||
  !data.research?.cacheReused ||
  !data.research?.invalidBatchRejected ||
  !data.research?.legacyCredentialRemoved ||
  !data.research?.retiredProviderRejected ||
  !data.preparation?.categoryReview ||
  !data.preparation?.bulkCategoryReview ||
  !data.preparation?.reviewFitsNarrow ||
  !data.preparation?.reviewIPCGuard ||
  !data.preparation?.automaticCopies ||
  !data.preparation?.cleanupDemoProtected ||
  !data.preparation?.overrideControls ||
  !data.preparation?.overrideDemoProtected ||
  !data.preparation?.cleanupTokenGuard ||
  !data.preparation?.noPrematureExport ||
  !data.preparation?.pathInjectionRejected ||
  !data.preparation?.keeperSaved ||
  !data.preparation?.batchApproved ||
  !data.preparation?.xmlRoundTrip ||
  !data.preparation?.manifestMatches ||
  !data.preparation?.importNotClaimed ||
  !data.preparation?.ownExportRejected ||
  !data.preparation?.snapshotMembershipMatched ||
  !data.preparation?.verificationPathRejected ||
  !data.invalidQueryRejected ||
  !data.playback?.playing
)
  throw new Error('Packaged smoke acceptance failed. Inspect the report.')
console.log(
  `Packaged UI + SQLite + scanner + native audio smoke passed: ${data.summary.files} files. Report: ${report}`
)

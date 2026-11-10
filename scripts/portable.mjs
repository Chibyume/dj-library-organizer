import { execFileSync } from 'node:child_process'
import { mkdir, rm, readFile, rename, access, writeFile } from 'node:fs/promises'
import path from 'node:path'
const root = process.cwd()
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const work = path.resolve(root, '../../work')
const outputs = path.resolve(root, '..')
const bundle = path.join(outputs, `DJ Library Organizer ${pkg.version}.app`)
const archive = path.join(outputs, `DJ Library Organizer-${pkg.version}-mac-arm64.zip`)
const extracted = path.join(work, 'portable-bundle')
await rm(extracted, { recursive: true, force: true })
await mkdir(extracted, { recursive: true })
execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, archive])
execFileSync('/usr/bin/ditto', ['-x', '-k', archive, extracted])
const profile = path.join(work, 'portable-smoke-profile')
await rm(profile, { recursive: true, force: true })
await mkdir(profile, { recursive: true })
await writeFile(path.join(profile, 'research-key.encrypted'), 'synthetic opaque retired credential')
const report = path.join(work, 'portable-smoke.json')
await rm(report, { force: true })
const pairs = [
  path.join(work, 'package'),
  path.join(root, 'dist'),
  path.join(root, 'node_modules'),
].map(source => [source, source + '-portability-held'])
const moved = []
try {
  for (const [source, held] of pairs) {
    await rename(source, held)
    moved.push([source, held])
  }
  execFileSync('/usr/bin/open', [
    '-n',
    path.join(extracted, `DJ Library Organizer ${pkg.version}.app`),
    '--args',
    `--test-profile=${profile}`,
    `--smoke-report=${report}`,
  ])
  const deadline = Date.now() + 180000
  let found = false
  while (Date.now() < deadline) {
    try {
      await access(report)
      found = true
      break
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  if (!found) throw new Error('Relocated app did not produce its smoke report.')
  const data = JSON.parse(await readFile(report, 'utf8'))
  if (
    data.summary.files !== 18 ||
    data.after.rows === 0 ||
    !data.playback?.playing ||
    data.classification !== 'Jersey Club' ||
    !data.security.sandbox ||
    !data.security.contextIsolation ||
    data.security.nodeIntegration ||
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
    !data.invalidQueryRejected
  )
    throw new Error('Relocated app acceptance failed.')
  console.log(
    'ZIP extraction + LaunchServices launch passed with original build/dist/node_modules unavailable: 18 generated files, automatic tags, practice and custom playlists, all-Junk confirmation and physical Trash restore, UI classification, native preview and restricted IPC.'
  )
} finally {
  for (const [source, held] of moved.reverse()) await rename(held, source)
}

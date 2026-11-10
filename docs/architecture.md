# Approved architecture and implemented boundary

## Current 0.9.3 boundary — October 22, 2026

The managed Rekordbox XML now represents the tagged practice library as well as strict preparation. Its stable namespace contains a **Practice Library** branch with All Practice Tracks, current multi-genre membership, Unsorted and personal playlist folders, plus a separate **Prepared playlists** branch. Current source/identity validation, normalized unique paths, bounded XML and stable signed-32-bit TrackIDs protect the handoff. Practice availability does not require a prepared-export classification approval. A preparation/hash failure is reported separately and does not prevent a validated practice export. Manual dated preparation exports retain their original approval, duplicate and cue/grid gates.

Tag and personal playlist changes are part of the automatic-output input fingerprint. Organization completes before generation. Local genre labels are playlist membership, not embedded tag or Rekordbox My Tag writes. The native Rekordbox Collection and previously imported lists remain unchanged until the user refreshes the XML browser and explicitly imports playlists; automatic replacement of native playlist memberships is not claimed.

Catalogue reconciliation treats a changed device number as an identity alias only with the same stable volume UUID, inode and birth evidence. A fresh native observation can preserve the original catalogue ID, tags and memberships, with a private pre-merge backup and transaction for legacy duplicate records. Pathname equality alone never proves identity; a genuine replacement invalidates the displaced location without inheriting its manual evidence, while a remaining hard-link location can retain the old instance. Explicit Trash/catalogue-removal suppression remains in force across device-number drift. Native file-operation journal key format and fresh TOCTOU checks remain unchanged.

No audio/tag changes, personal scans, physical cleanup, dependency additions, background daemon or live Rekordbox database writes accompany these fixes. Verification uses isolated synthetic libraries. Installed-version import, repeated-import merging and playback remain separate native acceptance checks.

## Historical 0.9.2 boundary — October 17, 2026

Junk is a dedicated sidebar route over the existing `_JUNK` catalogue category. Its bulk Trash action requests a server-selected, frozen whole-category preview independent of renderer search, pagination or selected IDs. The existing final-confirmation, journal, current native identity, best-effort continuation and restore machinery performs the batch. Changed scope or stale identity rejects confirmation; no opening or cancellation triggers a file move. Selected-song batches retain their existing bounded identity API.

Visible Trash contains only `availability='trashed'` instances. Blocked catalogue-only `removed` records are hidden from every visible library/source/count query while their suppression and recovery data remain in schema 8. Scans do not resurrect them. The current batch can still explicitly undo its own catalogue-only removals. No schema migration, permanent deletion, permission workaround, audio/tag editing, unrelated Finder Trash inventory or live Rekordbox database write is introduced.

New selected/Junk moves acquire a SHA-256 proof only after explicit confirmation, using bounded 1 MiB reads through an O_NOFOLLOW/nonblocking descriptor and exact native/descriptor identity, size and timestamp checks before and after reading. The proof is saved before the native effect. Restore can accept ctime-only drift with unchanged inode/birth/size/mtime only when a stable fresh hash matches that original proof; the native helper still checks the fresh full expected identity immediately before moving. Legacy journals without proof remain strict. Hash read failures fall back per file and do not stop independent moves. Verified reads are capped at 32 GiB per file; the whole-Junk scope is explicitly capped at 10,000 active instances and checked for recovery-journal capacity without truncation.

## Historical 0.9.1 boundary — October 16, 2026

The user's Trash continuation request extends selected-song removal with recoverable catalog-only fallback and a browsable Trash library. It does not authorize permanent deletion, audio/tag rewriting or bypassing macOS file permissions.

- Schema 8 adds `library_removals`, retained original availability and a distinct `removed` state. Both `removed` and native `trashed` instances leave ordinary library/source/summary/export queries and background organization/classification. Scanner reconciliation does not silently reintroduce them.
- The selected-file preview records native-move versus catalog-only actions. A native preflight/execution failure can remove only the catalog entry and record `original-kept` or `unconfirmed` location evidence while the remaining batch continues. Durable per-file intent/outcome, backup, current identity and no automatic retry of uncertain native effects remain required. Existing failed/uncertain selected-song journal entries can be reconciled into the same removed-library state.
- Trash is an explicit paginated/searchable library view. Metadata joins catalog-only removal records with selected-song and duplicate-cleanup journals, preserving historical trashed rows even without a usable recovery receipt. Original path, recorded Trash path, time, operation and reason describe stored evidence, not an unrestricted filesystem search.
- ID/revision-bound Restore selected routes confirmed native moves through existing journal/content/source/no-overwrite guards and returns catalog-only entries using saved availability. Missing/invalid physical recovery evidence produces a per-file error and may require Finder recovery. Tags, manual decisions and custom playlist memberships remain stored. Trash has no normal playback, tagging, playlist-add/export or repeat-Trash controls.
- The frozen sandbox bridge accepts bounded file identities and returns bounded per-file restore results. No renderer path/shell access, privileged permission workaround, permanent deletion, Trash-emptying or live Rekordbox database operation is added. Successful explicitly confirmed native Trash/restore remains the sole audio-path mutation.

The 0.9.0 boundary below remains applicable except where the explicit removal/Trash behavior above supersedes it.

## Current 0.9.0 boundary — October 15, 2026

The user explicitly authorized automatic organization of the complete inventoried catalogue through local tags, smart practice views and custom playlists, while preserving audio files. They also requested an explicit selected-song Move to Trash action. This current boundary supersedes narrower descriptions in the historical milestones below.

- Schema 7 stores local genre/version/use/familiarity tags, manual add/remove overrides, a dirty organization queue, custom folders/playlists and many-to-many file memberships. No audio tag writing, file copying or physical folder reorganization accompanies tagging or playlist membership.
- All Practice Tracks contains every inventoried file marked available, independently of category, classification approval, workflow placement or duplicate inclusion choices. Unknown genres remain in Unsorted. Tools, samples and full mixes remain available through both practice and dedicated views. Counts describe file instances; overlapping genre/playlists do not imply unique recordings.
- Automatic tags use stored embedded metadata, existing specific classifications, exact active Rekordbox references and current user-approved research. Explicit version-style evidence takes priority over broad genre labels. A specific saved Latin placement is retained over generic Latin metadata. No artist-only genre, crowd familiarity or energy claim is inferred.
- Existing manual category decisions migrate into protected manual genre overrides. Explicit genre edits update the primary prepared-export category and invalidate relevant approvals. Automatic derived tags and manual use/version/familiarity changes do not increment catalogue revisions or invalidate unrelated export approvals. Classifier revision 3 approvals/acknowledgments remain current during revision 4 only when the complete current input/rules digest and full semantic proposal are unchanged; changed evidence still requires review.
- Review uses the same preparation evidence and held reasons as the Rekordbox preview, with separate held and eligible-but-unapproved filters. Practice and custom playlist M3U8 export remain independent of classification approval; prepared XML export keeps its existing eligibility, duplicate, reference and approval gates. The organizer never writes the live Rekordbox database.
- Selected-song Trash is explicit, previewed and recoverable. Opaque IPC tokens bind IDs/revisions and current source/file/reference evidence to the confirmed operation. Private journals, backups, native no-follow/local-file checks and conditional restore protect against stale plans, occupied paths and uncertain outcomes. Original audio bytes and embedded tags remain unchanged; only an explicitly confirmed Trash/restore moves a selected file. No permanent deletion exists.
- Tagging/classification use bounded batches in the library utility process and yield between batches. New scans, settled arrivals, XML and approved-research changes schedule organization. Startup tagging reads the existing catalogue; it does not authorize a new personal-folder scan. Existing automation remains opt-in while the app is open.
- Renderer isolation, exact trusted-frame checks, strict bounded IPC schemas and native-selected export destinations remain in force. MusicBrainz is the only built-in research service. No AI integration, key storage or model endpoint is reintroduced.

The earlier milestone descriptions below are retained as historical implementation records.

The user explicitly authorized bulk duplicate selection and removal of extra files on October 11, 2026. Version 0.7.0 adds only recoverable, hash-verified duplicate Trash/restore to the earlier read-only boundary.

Keep changes scoped to one feature at a time. Building or testing the app does not authorize changes to a personal library.

## Phase 1A implementation

- Sandboxed, context-isolated React renderer. No Node integration, arbitrary filesystem/shell IPC, external navigation, permissions or HTTP(S) requests.
- Bundled UI assets; no production development server.
- Restricted preload with a frozen bridge. Main-process validation of every command, argument, window, exact local URL and top-level frame.
- Electron utility process owns SQLite and read-only scanning. Metadata runs in bounded worker threads; cancellation terminates a current parser worker.
- Native Objective-C helper uses Foundation file-resource values, Darwin lstat and AVAudioPlayer. Persistent line-delimited JSON requests; no shell execution. Native helper runs under the parent app's normal macOS permissions.
- SQLite WAL, migrations via user_version, directory checkpoints, original tag evidence, transactional manual decisions and revision checks.
- Stable internal UUIDs; separate physical instance/location records. Filesystem key combines volume, device, inode and birth information; these are supporting identity evidence, not universal content identity. The 0.5.0 preparation module adds a complete-file content-hash audit.
- Full discovery traverses selected roots; broad-home Smart Scan traverses remembered audio directories and Downloads. Directory events are not a correctness dependency. Version 0.8.0 adds opt-in polling of selected source folders for stable arrivals; full discovery remains an explicit operation.
- Native cloud/dataless inspection precedes audio reads. Metadata parser uses a checked O_NOFOLLOW descriptor with inode/device/size validation, random-access bounded reads, time limit and worker heap limits. Concurrent provider eviction after inspection is an outstanding device-validation risk.

## Data and state

Schema 1 has sources, files, locations, scans, scan_queue, decisions and tag_evidence. Every manual category/review decision is versioned and recorded transactionally. Scan updates do not overwrite a manual category. Changed files retain manual decisions and flag File Changed; unavailable sources remain registered.

Future migrations add recording/version associations, field-level research evidence, approved overrides/approvals, rules, playlists/memberships, duplicate groups, XML snapshots, manifests and operation journals. Never add a music-mutating operation without implementing the separately approved plan/journal/recovery boundary.

Keep availability, review, physical location, category, membership and rekordbox handoff state independent. Logical recording counts are unavailable until conservative recording/version associations exist. Current counts are file instances and explicitly overlapping subsets.

## Future integration gates

Phase 1B: immutable XML bytes/hash; disabled external entities/network resolution; DTD rejection; structural/resource validation; file/folder picker and drop; conservative local matching and snapshot conflict handling.

Phase 2: explicit online consent; replaceable providers; metadata/date provenance; exact 2007/2008 split only with established reggaeton/year evidence; complete-hash exact-copy claims; reviewed keeper decisions; explicit bulk eligibility; watches plus reconciliation; approved XML/M3U8 manifests and tested manual handoff.

A prior milestone observed installed rekordbox 7.2.19.0342. The official rekordbox 7 manual documents the import menus, but actual repeat imports/metadata conflicts/playlist updates/cue preservation remain GUI-untested. No internal database writes or UI-driven sync.

Phase 3: exact-plan approval, durable intent before effects, no overwrite, root containment/race checks, source/version verification, cross-volume copy-verify-remove, conditional recovery/undo, verified format-aware tag backups. No permanent deletion. Prefer stable paths for referenced audio; use backup and explicit relocation workflows.

## Performance targets

Proposed target is a 50,000-file catalog with a 100,000-row stress test; p95 search/sort under 250 ms, indexed initial view under 3 seconds on local SSD, idle below 2% of one core and aggregate idle memory below 600 MB. The 50,000-record synthetic SQLite query benchmark measured p95 23.79 ms over 15 queries. Renderer stress, full scans, sustained idle resources and the 100,000-row case remain targets until measured. This first build queries 500-row pages with DOM virtualization. Per-file worker startup is intentionally conservative and may need pooling before large real scans.

## Primary references

- https://www.electronjs.org/docs/latest/tutorial/security
- https://www.electronjs.org/docs/latest/api/utility-process
- https://support.apple.com/guide/mac-help/control-access-to-files-and-folders-on-mac-mchld5a35146/mac
- https://rekordbox.com/en/support/faq/operation-hints-7/
- https://rekordbox.com/en/support/developer/
- https://cdn.rekordbox.com/files/20260807093645/rekordbox7.2.18_manual_EN.pdf
- https://musicbrainz.org/doc/MusicBrainz_API
- https://picard-docs.musicbrainz.org/en/latest/variables/tags_basic.html
- https://acoustid.org/webservice

Phase 1B implementation: `xml-worker.ts` performs strict streaming SAX validation into private staging SQLite plus original-byte capture. `rekordbox.ts` owns native-inspected candidate sessions, import/cancel, immutable content-addressed XML, atomic snapshot activation, conservative matching, paginated references, and read-only evidence queries. The service emits XML progress separately from scan progress. Main keeps native pickers and IPC sender/schema checks; preload resolves only disk-backed File objects. Renderer components separate connection and per-file evidence from the library table. Schema 2 adds snapshot/track/node/membership/match/preview evidence and source-enabled state. All personal data remains in the local profile; no audio or rekordbox write command exists.

## Local automatic classification (0.3.0)

`classification.ts` is a deterministic proposal engine with bounded input, explicit genre aliases, specific remix/edit phrases, user-rule precedence, workflow review and unresolved recording years. It never inspects audio or contacts a provider. `classifier.ts` runs in the existing utility process, checkpoints at most 100 file records per transaction and yields between batches. Its SQL reads only inventoried metadata and exact active snapshot references. It persists proposals, provenance/reasons, acknowledgement hashes, settings, pending work, last-job progress, explicit rules and signature-bound confirmed era years. Source tags, original years, musical genre evidence and manual choices remain distinct.

Schema 3 backs up an existing schema-2 profile before migration. File evidence/manual-change triggers enqueue affected records and invalidate rule previews. Snapshot reconciliation/import schedules a cached catalog pass. Startup resumes enabled work; pause persists and retains the queue. Failures roll back the current batch and preserve pending work. No new standalone background service is installed. Renderer/main expose only validated IDs, bounded literal rule definitions, booleans and guarded era-year changes. The main process retains sender/frame checks; preload exposes no path, filesystem or shell capability.

`Classification.tsx` provides visible progress, pause/resume, a rule preview/editor and a per-track explanation/year-confirmation panel. Requests are independent where possible; stale/unmounted rule previews are ignored and cancelled. Suggestions remain Ready for Approval and cannot become manual approvals through reprocessing. The table calls the original embedded year Tagged Year.

## Optional online research (0.4.0)

Schema 4 adds provider-scoped research results and metadata query cache, separate approved values, a durable bounded queue and job state. Existing profiles receive a consistent backup before this migration. Approved-value triggers invalidate classifier inputs and enqueue files; original tags and manual category/review choices are preserved. Classification engine revision 2 includes only current user-approved online genre evidence.

`research-provider.ts` contains only MusicBrainz. It searches/looks up recording entities at 1.1-second intervals with capped retries for 429/503, checks title/artist/duration/version disambiguation, and reports database first-release coverage and community genre limits. Structured fields are bounded and validated; response bodies are capped at 3 MiB and redirects rejected. No model SDK or AI endpoint remains.

`research.ts` owns five-minute preview tokens, maximum 50-track batches, minimized sharing fields, 7-day cache, source/signature/input invalidation, async cancellation and 120-second per-track timeouts in the utility process. The next-unresolved picker examines at most 1000 catalog records. Cached responses are pinned to their sharing preview so cache expiry cannot increase a batch's request budget. Only previewed IDs execute; unpreviewed pending work is preserved, including when resuming a smaller batch. Pending queue resumes only through a fresh preview; in-flight interrupted/failed requests are marked uncertain rather than automatically resubmitted. Provider errors are not logged or returned raw. Only selected stored public HTTPS source URLs can be opened externally by main.

## MusicBrainz-only research (0.5.1)

The OpenAI adapter, SDK dependencies, key form, key IPC, encryption/decryption/storage implementation and model-specific diagnostics were removed at the user's request. `research-retirement.ts` only unlinks the exact previous credential file and UUID-named temporary key files in the active profile; it never reads/decrypts them or touches shared Keychain items. Cleanup runs at startup. The preview IPC schema accepts only `musicbrainz`; the service independently rejects retired providers. Startup transaction removes non-MusicBrainz queues/results/jobs while preserving explicit `research_approved` choices, era records and manual classifications. Schema stays 5; no schema migration is needed from 0.5.0. Older schema upgrades retain their existing backup behavior.

`research-failure.ts` reports MusicBrainz HTTP status or bounded network/timeout categories, never raw response bodies or messages. The first exhausted lookup failure stops the batch and retains unvisited tracks. Uncertain requests are never resubmitted automatically.

The separate-profile smoke runner injects a synthetic MusicBrainz adapter, verifies preview/consent/approval/cache and confirms retired credentials disappear, old-provider IPC is rejected, and the key bridge/form is absent. Ordinary launches use the real MusicBrainz adapter. No production library is used for development tests.

MusicBrainz references:

- https://musicbrainz.org/doc/MusicBrainz_API
- https://musicbrainz.org/doc/MusicBrainz_API/Search

## 0.5.0 playlist preparation

Schema 5 adds full-file hash evidence, persisted duplicate-job progress, duplicate inclusion decisions, independent classification approval fingerprints and export journal/manifests. A pre-upgrade schema-5 backup protects prior catalogs. Full hashing uses one bounded worker and no-follow descriptor with before/after identity/stat checks. Completed hashes are reusable; source authorization/local availability is checked again each pass. Native/source checks also run before/after writing exports. Expensive catalog preparation runs in the library utility process with 500-row keyset reads; UI payloads are bounded to 50 tracks/members and 10 groups.

Duplicate decisions are tied to sorted group membership, signatures, paths, hashes and XML evidence. Exact and same-title candidate groups remain different. Decisions affect playlist inclusion only, not catalog visibility, audio location or native collection entries. A unique known referenced exact copy may be suggested, never selected silently.

Approval uses server-held expiring previews with selected/all scope, eligibility reasons and evidence fingerprints. On approval/export the server recomputes eligibility and compares the plan; stale plans do nothing. Known possible/ambiguous XML matches are linked through their candidate IDs for withholding, not silently treated as unreferenced. Physical duplicate Trash/restore is described below; general physical organization remains unimplemented.

Exports use a native-chosen parent and new UUID-suffixed directory, exclusive file creation, fsync, journal state, content checksums and a final COMPLETE marker. Existing files and source snapshots are never targets. Generated XML is privately staged and checked by the strict XML import worker before output. Preparation is copied only from one conflict-free exact reference. Output uses a dated managed namespace because live repeat-import merging has not been proven. User-reported import is distinct from verified membership; a supplied fresh XML can now be compared against the immutable export manifest (0.6.0).

## Snapshot membership comparison (0.6.0)

`export-verification.ts` reads the private immutable version-1 manifest and active parsed snapshot from SQLite. It validates manifest identity/count/category/path limits (100,000 expected paths), rejects own-export product/hash/path, requires a rekordbox product declaration and plausible newer file/import times, and locates one exact namespace folder. It builds maps using bounded keyset reads, yields regularly, and checks cancellation and active snapshot identity at every yield. It compares exact case-sensitive NFC-normalized paths within the expected group/category tree; snapshot TrackIDs are never assumed to equal export IDs. Duplicate namespaces/groups/playlists/collection paths/repeated memberships and unresolved references prevent a clean match. Only extra playlists within the batch namespace count as discrepancies. Summaries are bounded to the supported music categories and five examples per category; full counts cover every membership.

Preparation serializes comparison with existing operations, journals the report only after a successful complete pass, and preserves concurrent user-reported import flags. Existing schema-5 export JSON gains optional completion time and verification fields; no schema change or destructive migration is needed. History computes whether the stored report still refers to the active snapshot ID/hash. IPC accepts only an export UUID; it cannot select a path, fabricate a snapshot or supply a manifest. `ExportVerification.tsx` labels scope, dates, stale state and discrepancies separately from the user's import report.

The comparator does not authenticate XML product labels/timestamps, inspect the live native collection, hash current audio, or validate cues/grids/playback. Actual installed-version import/repeated-import tests remain a separate acceptance gate. References checked October 11, 2026: official XML interchange spec (TrackID/Location membership, folder hierarchy) and rekordbox 7.2.14 manual, linked in the import checklist.

## Category placement and review (0.6.2)

Classifier revision 3 treats placement and approval separately. Current citation-backed approved research precedes general tags; exact active XML genre playlist memberships are a fallback, bounded to 20 distinct names per file. Title-only/ambiguous matches contribute no membership. Explicit saved rules and version labels retain priority, while recording-identity conflicts and partial/unavailable files remain held. Multiple plausible genres choose a tentative category with a conflict status. Generic Latin maps to Latin Other for review; explicit mixes and sample/loop material have workflow placements. These statuses cannot enter approved playlist exports.

MUSIC_CATEGORIES is shared across settings, validation and export checks; generic Reggaeton is browsable but held for confirmed recording/version era. Counts come from the same catalog category field used by sidebar queries. Saved research citations are exposed independently of transient lookup history and require the exact stored result ID and source URL at the main-process boundary. Manual decisions remain preserved. The operational --skip-startup-scan flag suppresses just that launch's reconciliation without changing the user's stored sources or settings.

## Bulk duplicate cleanup (0.7.0)

`duplicate-choice.ts` ranks copies deterministically by snapshot preparation, measured file format properties and location. `Preparation.autoChoose` handles exact groups before candidate groups, recomputes membership, preserves valid prior choices, and keeps uncertain versions. It never grants classification/export approval. `reconcileCleanupChoices` carries the same selected keeper across removal/restoration of group members, without overriding a different later choice.

`duplicate-cleanup.ts` uses a server-held 15-minute plan with full evidence fingerprint, a consistent SQLite backup, and an atomic fsynced private journal per batch. It rejects changed plans and never accepts paths over renderer IPC. Eligible physical removal requires a resolved exact-byte group, a retained keeper, current source/metadata/location evidence, and, by default, no reference in any stored XML or playlist export. In 0.7.1 an explicit includeReferenced preview option permits referenced extras; the server-held token and journal retain the option and affected count. The user authorized that override on October 13, 2026. Existing live collection entries are not redirected. Every keeper is freshly hashed before its first removal and revalidated before each extra; every extra is freshly hashed. Worker checks are bounded to 32 GB and 180 seconds and cancellable. Native Foundation Trash verifies canonical paths, ordinary local files, one hard link, and the expected device/inode/birth/size/mtime/ctime immediately before moving. Actual destination paths are journaled. The small final filesystem race against uncooperative external mutation cannot be made atomic with Foundation Trash; failures/uncertain outcomes stop and are never replayed automatically.

Cleanup runs as a cancellable background task in the existing utility process. Concurrent source, scan, XML, category and duplicate mutations are blocked. Confirmed moved entries become `availability=trashed`; default catalog views/counts omit them while retaining recovery evidence. Scans do not turn intentionally trashed entries into generic missing files. Restore verifies bytes and source access, refuses occupied paths, updates verified signatures, and refreshes classification. Private JSON journals avoid a schema migration; do not reopen old app builds after using cleanup because they do not understand its visibility/recovery state. The UI accepts only opaque tokens/IDs and shows one batch action, progress, current-batch restore and up to 50 earlier batch summaries. Restore accepts only a validated batch UUID and verifies the private journal, original catalog location and actual Trash bytes. No permanent delete or native Rekordbox write is implemented.

Version 0.7.1 ranks exact collection references first, playlist appearances second, then cues/grids, audio quality and location. Only the active imported snapshot contributes ranking, so importing repeated snapshots cannot inflate popularity. Re-pick is explicit and supersedes prior copy decisions when requested. Research and category decisions remain independent.

## Automatic arrivals and XML handoff (0.8.0)

Automation runs in the library utility process, opt-in per specific existing source, every 30 seconds while open. A 20-second stable native signature gate precedes bounded incremental ingestion; no missing-file claims are made by partial passes. It serializes with scans, research, cleanup, XML and preparation. Eligible local classifications can receive standing playlist approval; uncertain evidence remains held. The managed output directory is profile-owned and writes one stable XML atomically, retaining one previous version. Rekordbox refresh/import is a separate native action, never inferred from generation. Optional inbound monitoring reads a user-selected native XML export after settling. Schema 6 persists settings and status; maintenance launch suppresses automatic startup.

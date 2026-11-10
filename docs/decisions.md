# Implementation decisions

## ADR 001 — Electron UI and an isolated local catalog

Accepted. React/TypeScript UI with Electron; SQLite in a utility process. Expensive/cancellable reads stay outside main/UI threads. A packaged build uses local assets and requires no server. Use HTML table semantics with TanStack Virtual; defer advanced TanStack Table integration until it provides a concrete benefit.

## ADR 002 — Native helper in Objective-C

Accepted implementation adjustment. The installed Swift 6.1.2/Command Line Tools SDK reports duplicate SwiftBridging module definitions while importing system frameworks. Do not modify system headers, install Xcode automatically or weaken macOS security. A small Objective-C helper accesses the same Foundation/AVFoundation/Darwin services through Clang and avoids Swift runtime/toolchain dependency.

## ADR 003 — No audio-mutating API in Phase 1A

Accepted. The renderer can query registered files, request a native source chooser, start/cancel scans, save classifications/review state, reveal authorized instances and control local preview. It cannot send arbitrary paths for content reads or request filesystem/tag/rekordbox changes. Choosing a category is app-only, independent of future operation approval.

## ADR 004 — Conservative identities and cache hints

Accepted. An internal UUID outlives path changes. Physical-key evidence includes volume/device/inode/birth information; separate location records deduplicate overlapping roots/hard links, but independent identical copies remain visible. Size plus nanosecond mtime/ctime drives bounded initial cache reuse. This is not content proof. Complete hashes, audits and additional generation evidence must precede exact-duplicate/mutation claims.

macOS can adjust birth time if a test sets modification time before creation. Tests restoring mtime must preserve this distinction; do not weaken identity checks merely to make an unrealistic fixture appear unchanged.

## ADR 005 — Synthetic demo is explicit

Accepted. Bundled generated test tones/fictitious tags let users inspect the real interface and native scanner safely. Demo source is labeled. No prepopulated song library, claimed research match or simulated successful export appears as real work.

## ADR 006 — Local development package before distribution

Accepted. Build a standalone arm64 app early and exercise its real processes. Local development signing is distinct from Developer ID signing/notarization. No Gatekeeper bypass. Distribution signing/notarization remains a gate requiring credentials/tooling and explicit release authorization.

## ADR 007 — Separate readable tags from complete audio

A missing sample rate does not prove corruption when the parser identifies an audio stream and codec. Show unknown fields without inventing them. If parsing fails later, keep any already-read embedded tags as partial evidence, preserve the incomplete/corrupt status and suppress complete-duration claims. Never silently clamp MP4 sizes or rewrite music to make a parser pass. Parser revisions invalidate cached decisions once without replacing manual categories.

Default system exclusions apply to actual locations, not every ordinary folder sharing names such as library, System or dev. Full Discovery must revisit locations skipped by an earlier exclusion policy.


## ADR 008 — Immutable XML snapshots and conservative links

Accepted for Phase 1B. Native pickers or disk-backed File objects authorize bounded XML selection; opaque candidate UUIDs authorize imports. The sandbox bridge uses Electron webUtils to resolve actual dropped Files and rejects JS-created files and path strings. Source XML stays read-only and XML audio references never become scan authorization.

A strict SAX worker stages validated records in its own SQLite database, copies original UTF-8 bytes from a checked no-follow descriptor, and hashes them. It rejects DTD/entities, malformed structure/counts and resource overrun. The catalog attaches only the app-owned stage and atomically activates a new snapshot; failures retain the previous active snapshot. Unknown XML fields remain in original bytes. Track IDs are snapshot-local, preparation is evidence only, and mismatched versions are never inferred from titles.

Exact catalog paths can establish snapshot references; size/duration differences, case-only matches and historical locations require review. Ambiguous paths never receive a guessed link. Matching never overwrites app decisions or embedded metadata. Import time and disk modification time remain separate. An XML snapshot is neither a live connection nor a complete backup.

## ADR 009 — Separate file capabilities and source access

Inventory, availability, native preview, tag reading, signal analysis, and target-version importability are separate states. Preview evidence is tied to the file signature and invalidated when it changes. This build reads existing BPM/key tags but cannot estimate them. Actual per-file rekordbox compatibility remains untested.

Pausing a source revokes scans/preview through it while retaining the catalog and decisions. It does not remove overlapping active authorization, delete file rows, or establish that files are missing. Schema 1 migration creates a consistent SQLite backup before schema 2 changes. No older schema is reset or silently downgraded.


## ADR 10 — Local automatic suggestions before export work

The user confirmed XML import works and explicitly prioritized automatic category classification. Ship a local classifier milestone before Phase 2A exports. No external research or signal-analysis dependency is required. Clear exact genre synonyms and specific target-style/version phrases can propose a category; artist/language/BPM, arbitrary numbers and isolated ambiguous title words cannot. Category is separate from original musical genre. A genre word spread across separate title/filename fields is not a version phrase. Contradictory evidence remains unresolved; exact XML recording identity conflicts block proposals.

Automatic categories remain suggestions, never approvals. Transactional bounded utility-service batches preserve every manual/exclusion/review decision. Confirmed era years are tied to the physical instance's current signature, stored separately and recorded in decision history. A verified user assertion, not the ordinary album/year tag, drives the exact 2007/2008 reggaeton split. Changed files require reconfirmation. Persistent evidence hashes, acknowledgement hashes and queue checkpoints make repeated processing stable and recovery safe.

Rules are explicit exact genre or literal word-boundary title/filename mappings. Every addition requires a preview with complete affected/protected/conflict counts and a bounded example list. Epoch guards reject stale previews; cancellation and two-minute/five-minute limits bound work and approvals. Default rules never grow from a single correction. Contradictory saved rules require review.

## ADR 011 — Cited online proposals, explicit batch sharing and replaceable providers

Accepted. Add free MusicBrainz and optional direct OpenAI Responses research in the desktop utility process, without requiring a cloud account for local classification. An explicit five-minute preview/consent token grants only the bounded batch's minimized metadata query. Nothing automatically contacts a provider after startup/import. Paid requests are capped and not blindly retried after uncertain failures. No audio, private paths, whole XML or fingerprints leave the Mac.

A model can interpret cited search evidence but cannot alone establish a saved identity, date or genre. Uncited fields are withheld; ambiguous versions stay reviewable. User approval saves independent evidence and allows existing deterministic category rules to combine it with local sources. Manual choices and original tags remain separate. Known database release dates are labeled for coverage; reissue dates do not date original recordings and original dates do not date later remixes.

API keys remain in main/session memory unless the user opts into macOS encryption. Direct provider routing avoids introducing a second billing/authentication gateway into this local app. No key is embedded, searched for in the user's home, or bundled. There is no DevTools payload capture. Distribution signing and actual credential/device validation remain distinct gates.


## ADR 12 — Playlist preparation before physical organization

The user wants to DJ without sorting individual songs and asked to continue after prioritizing duplicates, batch approval and export. Version 0.5.0 delivers those in playlist-only mode. A full hash establishes exact byte equality; conservative artist/full-title matches remain candidates. Explicit keeper/all-version decisions affect export inclusion only. Existing native collection duplicates and physical copies are retained.

Prepared classification approval is separate from suggestion/manual category and separate from file-operation authorization. Eligible rows are approved through a server-held expiring preview. Unchecked enabled-source files hold approval until the duplicate audit is complete. Source identity and all relevant evidence are revalidated before export; changed plans must be previewed again.

Use new dated managed batch namespaces because safe in-place native merging has not been verified. Private parser validation, exclusive file creation, an export journal and completion marker make partial output recognizable. Saving, user-reported import and actual fresh-XML verification are distinct; the last remains a future feature. Do not mutate the user's live collection to run synthetic acceptance tests.


## 0.5.1: retain MusicBrainz, remove AI integration

The user explicitly requested MusicBrainz only. Remove the model adapter/dependencies and credential capability completely, rather than hiding a provider toggle. Active-profile startup deletes integration-owned encrypted credentials without reading/decrypting them and retires unapproved AI results/pending jobs. Previously approved metadata remains a user decision with its original provenance; do not silently reset classifications. MusicBrainz remains consented per batch; local metadata classification continues automatically. This release keeps schema 5 and does not add a background watcher or live rekordbox synchronization.


## 0.6.0: compare supplied XML membership before adding intake automation

The next handoff milestone is a read-only, explicit snapshot comparison against the original exported manifest. Preserve "user reported imported" as distinct from observed snapshot membership. Match exact paths, not reused TrackIDs or title guesses, within the batch's unique folder hierarchy. Reject stale and self-generated evidence, show discrepancies, and never infer live collection/cue/playback success. Saved comparison JSON is backward-compatible within schema 5. Actual native import acceptance remains pending because no user-chosen live collection mutation was performed.

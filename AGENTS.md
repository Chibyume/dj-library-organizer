# Working rules

This is a local macOS DJ library organizer. See docs/architecture.md for the design and docs/handoff.md for the latest verification.

- Keep original audio and embedded tags unchanged. Scanning, tagging, playlist preparation, and export are read-only with respect to audio. Never write to the live Rekordbox database.
- Physical removals use recoverable macOS Trash after explicit confirmation, with fresh identity checks, a journal, and a restore path. Duplicate cleanup requires verified identical bytes. Protect known Rekordbox and export references by default; any explicit override must be shown in the preview. Never permanently delete files, automatically retry an uncertain move, or overwrite an occupied restore path.
- A failed selected-song move can hide the entry from the active library while keeping the original and the recovery record. Scans must respect catalogue-only removals. The all-Junk action previews its full scope, freezes membership, and checks it again on confirmation.
- Keep the renderer isolated and sandboxed. Validate the IPC sender, top-level frame, and inputs. Do not add renderer filesystem or shell access.
- Preserve manual decisions. Distinguish physical file instances from recording or version identity. Keep expensive jobs off the UI thread and support cancellation.
- Develop and test with synthetic fixtures. Do not scan personal music autonomously or commit audio, private paths, library exports, databases, credentials, or logs.
- Run formatting, type checks, integration tests, builds, and packaged smoke checks as relevant. Record exact checks and limitations in docs/handoff.md. A mock test does not prove Finder permissions or Rekordbox compatibility.
- Do not publish, start a background service, or change a personal library without the user's authorization.

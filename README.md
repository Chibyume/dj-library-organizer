# DJ Library Organizer

A local Mac app for keeping a DJ practice library together. Add your music folders, tag and sort tracks, find duplicate copies, and build playlists for Rekordbox.

- **Practice Library** includes every available track, even when its genre or release year needs review. Genre tags and playlist membership live in the app's catalog.
- **My Playlists** is for crates you build yourself. Export a playlist as M3U8 to import it into Rekordbox.
- **Prepare for rekordbox** checks duplicates and classifications before exporting curated XML playlists. A stricter export does not hide tracks from practice.
- **Automatic downloads & sync** can watch selected folders while the app is open and update one XML file. Refresh Rekordbox's XML browser and import the playlists there; the app does not write to the live Rekordbox database.
- **Junk and Trash** let you review removals. Moving files to macOS Trash requires an explicit confirmation. The app keeps recovery records and never empties Trash.

Scanning, classification, and export leave audio and embedded tags alone. MusicBrainz lookup is optional and sends the previewed track metadata only after you approve that batch. No account or API key is needed.

## Build on a Mac

Use Apple Silicon macOS, Node 24, npm, and Xcode Command Line Tools. Install FFmpeg if you're running the integration tests; it generates synthetic test audio and is not shipped with the app.

```sh
npm ci
npm exec --no -- install-electron
npm exec --no -- electron-rebuild --only better-sqlite3 --arch arm64 --version 44.7.0
npm run start
```

Choose **Explore a synthetic demo library** to try the app without scanning your music. The demo uses generated tones and made-up track metadata.

```sh
npm run format:check
npm run typecheck
npm run build
npm test
npm run package
npm run smoke
```

Packaging creates an adjacent `DJ Library Organizer 0.9.3.app`. It is a local development build, without Developer ID signing or notarization. The build and test scripts write scratch files under `../../work` relative to the checkout, so build from a location where that directory is writable. The desktop smoke test needs an active Mac session.

See the [architecture](docs/architecture.md), [Rekordbox import checklist](docs/rekordbox-import-checklist.md), and [current handoff](docs/handoff.md). Bundled dependency licenses are in [third-party notices](THIRD_PARTY_NOTICES.txt).

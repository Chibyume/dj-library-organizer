# Local rekordbox import acceptance gate

Status: **not performed against the user's live collection**. Synthetic parser round trips do not establish live import behavior. User confirmed earlier snapshot import into the organizer only.

Record the installed rekordbox version and use a separate backup/test library or a deliberately chosen small playlist. Never delete/re-import prepared collection entries to force an update.

1. Keep a current rekordbox library backup and fresh XML snapshot. Save a small organizer export; check COMPLETE.txt.
2. Show rekordbox xml under Preferences > View > Layout / Media Browser; point Advanced > Database > Imported Library to the generated rekordbox.xml.
3. Expand the dated organizer namespace and import one small playlist into native Playlists. Verify paths, playback, names/counts and category memberships.
4. On tracks already in Collection, compare native TrackID/path reuse, cue/loop positions, beat grids, ratings and existing memberships. Inspect metadata conflict prompts; don't accept overwrites casually.
5. Re-import the same small playlist. Record whether it duplicates, merges, renames or replaces memberships. Do not assume a merge.
6. Export a second batch after an intentional membership/category change. Verify the separate dated folder and confirm that unrelated native playlists remain intact. Old batch folders require deliberate manual management.
7. Try the M3U8 alternative via File > Import > Import Playlist. Verify UTF-8 names and actual paths; it carries membership only.
8. Export a fresh XML from rekordbox and inspect it with Refresh Rekordbox Library. Record exact paths and playlist memberships observed. The organizer's 'I imported this batch' control is a user report only. In 0.6.0, use Prepare for rekordbox → Recent exports → Check against refreshed XML to compare paths/membership. This requires the dated batch folder and genre hierarchy. It cannot establish playback or cue/grid preservation, and does not verify M3U8-only imports without that hierarchy.

Primary sources checked October 11, 2026: [rekordbox XML interchange format](https://cdn.rekordbox.com/files/20200410160904/xml_format_list.pdf); [rekordbox 7 manual, pp. 19, 40, 45, 239, 249](https://cdn.rekordbox.com/files/20260409151936/rekordbox7.214_manual_EN.pdf).

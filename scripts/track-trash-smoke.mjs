import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import electron from 'electron'

// Only generated workspace fixtures enter this smoke's non-demo source. The
// native helper uses macOS Trash, then the app restores that exact new fixture.
await build({
  stdin: {
    resolveDir: process.cwd(),
    sourcefile: 'track-trash-native-smoke.ts',
    loader: 'ts',
    contents: `
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { LibraryDB } from "./src/db";
import { NativeHelper } from "./src/native";
import { TrackTrash } from "./src/track-trash";
import { physicalKey, signature } from "./src/scanner";
import { wav } from "./scripts/fixtures.mjs";

async function run() {
  const directory = await mkdtemp(path.resolve("../../work/track-trash-native-"));
  const root = path.join(directory, "generated-library"), profile = path.join(directory, "profile");
  await mkdir(root);
  const selectedPath = path.join(root, "Synthetic selected-song native smoke.wav");
  const retainedPath = path.join(root, "Synthetic retained-song native smoke.wav");
  await writeFile(selectedPath, wav({ title: "Synthetic Native Trash", duration: 1 }));
  await writeFile(retainedPath, wav({ title: "Synthetic Retained Track", duration: 1, frequency: 330 }));
  const hash = async (filePath: string) => createHash("sha256").update(await readFile(filePath)).digest("hex");
  const selectedHash = await hash(selectedPath), retainedHash = await hash(retainedPath);
  const helper = new NativeHelper(path.resolve("dist/native/organizer-helper"));
  let db = new LibraryDB(profile);
  let service = new TrackTrash(db, helper, () => {});
  let result: Awaited<ReturnType<TrackTrash["start"]>> | null = null;
  const report: Record<string, unknown> = { directory, helper: path.resolve("dist/native/organizer-helper"), generatedOnly: true, sourceDemo: false, originalHash: selectedHash, previewDidNotMove: false, nativeTrashConfirmed: false, persistedAfterReopen: false, nativeRestoreConfirmed: false, bytesUnchanged: false, untouchedBytesUnchanged: false };
  let failure: unknown;
  try {
    const source = db.addSource(root, false), id = randomUUID(), info = await helper.inspect(selectedPath), now = new Date().toISOString();
    db.db.prepare("INSERT INTO files(id,physicalKey,path,filename,sourceId,signature,title,size,availability,addedAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(id, physicalKey(info), selectedPath, path.basename(selectedPath), source.id, signature(info), "Synthetic Native Trash", info.size, "available", now, now);
    db.db.prepare("INSERT INTO locations(fileId,sourceId,path,available) VALUES(?,?,?,1)").run(id, source.id, selectedPath);
    const plan = await service.preview([{ id, revision: 0 }]);
    assert.equal(await hash(selectedPath), selectedHash);
    report.previewDidNotMove = true;
    report.preview = { files: plan.files.length, bytes: plan.bytes, references: plan.rekordboxReferences + plan.exportReferences };
    result = await service.start(plan.token);
    report.move = result;
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.moved, 1);
    await assert.rejects(lstat(selectedPath), { code: "ENOENT" });
    assert.equal(db.get(id)?.availability, "trashed");
    assert.equal(await hash(result.files[0]!.trashPath!), selectedHash);
    report.nativeTrashConfirmed = true;
    db.close();
    db = new LibraryDB(profile);
    service = new TrackTrash(db, helper, () => {});
    assert.equal(service.history().find((record) => record.id === result!.id)?.moved, 1);
    assert.equal(db.get(id)?.availability, "trashed");
    report.persistedAfterReopen = true;
    const recovery = await service.restore(result.id);
    report.restore = recovery;
    assert.equal(recovery.status, "restored", JSON.stringify(recovery));
    assert.equal(recovery.restored, 1);
    assert.equal(db.get(id)?.availability, "available");
    report.nativeRestoreConfirmed = true;
    assert.equal(await hash(selectedPath), selectedHash);
    assert.equal(await hash(retainedPath), retainedHash);
    report.bytesUnchanged = true;
    report.untouchedBytesUnchanged = true;
    const journal = JSON.parse(await readFile(path.join(profile, "track-trash", result.id + ".json"), "utf8"));
    assert.equal(journal.entries[0].status, "restored");
    assert.ok(journal.entries[0].trashPath);
    assert.ok(journal.entries[0].trashExpected);
    report.journalConfirmed = true;
  } catch (error) {
    failure = error;
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    // If an assertion fails after a confirmed move, still try the product's
    // verified recovery. Never delete fixtures or empty Finder Trash.
    if (result && !report.nativeRestoreConfirmed && service.history().some((record) => record.id === result!.id && record.moved > record.restored)) {
      try { report.finalRecovery = await service.restore(result.id); }
      catch (error) { report.finalRecoveryError = error instanceof Error ? error.message : String(error); }
    }
    helper.close();
    db.close();
    const reportPath = path.join(directory, "native-trash-smoke.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\\n", { mode: 0o600 });
    console.log(JSON.stringify({ reportPath, nativeTrashConfirmed: report.nativeTrashConfirmed, nativeRestoreConfirmed: report.nativeRestoreConfirmed, bytesUnchanged: report.bytesUnchanged, error: report.error || null }, null, 2));
  }
  if (failure) throw failure;
}
run().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
`,
  },
  outfile: 'dist/track-trash-native-smoke.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['better-sqlite3', 'music-metadata'],
})
execFileSync(electron, [path.resolve('dist/track-trash-native-smoke.cjs')], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})

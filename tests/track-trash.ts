import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  rename,
  link,
  symlink,
  readdir,
  chmod,
  utimes,
} from 'node:fs/promises'
import path from 'node:path'
import { LibraryDB } from '../src/db'
import type { Inspection, NativeHelper } from '../src/native'
import { physicalKey, signature } from '../src/scanner'
import { TrackTrash } from '../src/track-trash'
import type { TrackTrashChange } from '../src/track-trash-types'

async function fixture() {
  const directory = await mkdtemp(path.resolve('../../work/track-trash-'))
  const root = path.join(directory, 'synthetic-library'),
    trash = path.join(directory, 'synthetic-trash')
  await mkdir(root)
  await mkdir(trash)
  const db = new LibraryDB(path.join(directory, 'profile'))
  const source = db.addSource(root, true)
  let moves = 0,
    restores = 0,
    failAfterMove = false
  const denied = new Set<string>()
  let failRestoredInspection = false,
    restoredPath = ''
  async function inspect(filePath: string): Promise<Inspection> {
    if (failRestoredInspection && filePath === restoredPath) {
      failRestoredInspection = false
      throw Error('Synthetic post-restore inspection failure.')
    }
    const info = await lstat(filePath, { bigint: true })
    const inspected: Inspection = {
      regular: info.isFile(),
      links: Number(info.nlink),
      directory: info.isDirectory(),
      package: false,
      alias: false,
      cloudOnly: false,
      availabilityUnknown: false,
      device: String(info.dev),
      inode: String(info.ino),
      birth: String(info.birthtimeNs),
      size: Number(info.size),
      mtime: String(info.mtimeNs),
      ctime: String(info.ctimeNs),
      volume: null,
    }
    // NativeHelper emits sorted JSON keys; recovery parsing uses schema order.
    return Object.fromEntries(
      Object.entries(inspected).sort(([a], [b]) => a.localeCompare(b))
    ) as unknown as Inspection
  }
  const helper = {
    inspect,
    async call(
      command: string,
      args: { path: string; expected: Inspection; destination?: string }
    ) {
      assert.deepEqual(await inspect(args.path), args.expected)
      if (command === 'trash') {
        if (denied.has(args.path)) throw Error('Synthetic permission denied.')
        const destination = path.join(trash, randomUUID() + '-' + path.basename(args.path))
        await rename(args.path, destination)
        moves++
        if (failAfterMove) {
          failAfterMove = false
          throw Error('Simulated lost helper response.')
        }
        return { path: destination }
      }
      assert.equal(command, 'restore')
      await assert.rejects(lstat(args.destination!), { code: 'ENOENT' })
      await rename(args.path, args.destination!)
      restoredPath = args.destination!
      restores++
      return { path: args.destination }
    },
  } as unknown as NativeHelper
  async function add(name: string, availability = 'available') {
    const target = path.join(root, name)
    await writeFile(target, Buffer.from('Synthetic file for recoverable move testing: ' + name))
    const info = await inspect(target),
      id = randomUUID(),
      now = new Date().toISOString()
    db.db
      .prepare(
        'INSERT INTO files(id,physicalKey,path,filename,sourceId,signature,title,size,availability,addedAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
      )
      .run(
        id,
        physicalKey(info),
        target,
        name,
        source.id,
        signature(info),
        name,
        info.size,
        availability,
        now,
        now
      )
    db.db
      .prepare('INSERT INTO locations(fileId,sourceId,path,available) VALUES(?,?,?,1)')
      .run(id, source.id, target)
    return { id, revision: 0, path: target }
  }
  return {
    directory,
    root,
    trash,
    db,
    helper,
    add,
    inspect,
    get moves() {
      return moves
    },
    get restores() {
      return restores
    },
    loseMoveResponse() {
      failAfterMove = true
    },
    deny(filePath: string) {
      denied.add(filePath)
    },
    failNextRestoredInspection() {
      failRestoredInspection = true
    },
    close() {
      db.close()
    },
  }
}

test('selected-song Trash previews all paths and references, moves only after confirmation, and restores exact bytes', async () => {
  const f = await fixture()
  try {
    const track = await f.add('selected.wav'),
      untouched = await f.add('untouched.wav')
    const before = await readFile(track.path),
      other = await readFile(untouched.path)
    const snapshotId = randomUUID()
    f.db.db
      .prepare(
        "INSERT INTO rb_snapshots(id,sourcePath,importedAt,modifiedAt,hash,size,product,tracks,playlists,memberships,dangling,warnings,matchedAt,active) VALUES(?,?,?,?,?,1,'fixture',1,0,0,0,'[]',?,1)"
      )
      .run(
        snapshotId,
        path.join(f.directory, 'synthetic.xml'),
        new Date().toISOString(),
        new Date().toISOString(),
        'synthetic',
        new Date().toISOString()
      )
    f.db.db
      .prepare("INSERT INTO rb_tracks VALUES(?,?,'{}',?,'local','[]','[]')")
      .run(snapshotId, '1', track.path)
    f.db.db
      .prepare("INSERT INTO playlist_exports VALUES(?,'{}',?)")
      .run(randomUUID(), JSON.stringify({ tracks: [{ id: track.id, path: track.path }] }))
    const service = new TrackTrash(f.db, f.helper, () => {})
    const plan = await service.preview([{ id: track.id, revision: 0 }])
    assert.equal(f.moves, 0)
    assert.equal(plan.files[0]?.path, track.path)
    assert.equal(plan.rekordboxReferences, 1)
    assert.equal(plan.exportReferences, 1)
    const result = await service.start(plan.token)
    assert.equal(result.status, 'completed')
    assert.equal(result.moved, 1)
    assert.equal(f.moves, 1)
    assert.equal(f.db.get(track.id)?.availability, 'trashed')
    await assert.rejects(lstat(track.path), { code: 'ENOENT' })
    assert.deepEqual(await readFile(untouched.path), other)
    await assert.rejects(service.start(plan.token), /Preview selected files again/)
    const recovery = await service.restore(result.id)
    assert.equal(recovery.status, 'restored')
    assert.equal(recovery.restored, 1)
    assert.equal(f.restores, 1)
    assert.deepEqual(await readFile(track.path), before)
    assert.equal(f.db.get(track.id)?.availability, 'available')
    assert.equal(service.history()[0]?.restored, 1)
    assert.ok(
      (await readdir(f.db.directory)).some(
        name => name.startsWith('before-track-trash-') && name.endsWith('.sqlite')
      )
    )
  } finally {
    f.close()
  }
})

test('selected-song Trash rejects stale revisions, changed files and changed reference evidence without moving anything', async () => {
  const f = await fixture()
  try {
    const track = await f.add('fresh.wav'),
      service = new TrackTrash(f.db, f.helper, () => {})
    await assert.rejects(service.preview([{ id: track.id, revision: 1 }]), /changed/)
    const plan = await service.preview([{ id: track.id, revision: track.revision }])
    f.db.db
      .prepare("INSERT INTO playlist_exports VALUES(?,'{}',?)")
      .run(randomUUID(), JSON.stringify({ tracks: [{ id: track.id }] }))
    await assert.rejects(service.start(plan.token), /references changed/)
    const next = await service.preview([{ id: track.id, revision: track.revision }])
    await writeFile(track.path, 'The synthetic source was changed after preview.')
    const fallback = await service.start(next.token)
    assert.equal(fallback.removed, 1)
    assert.equal(fallback.files[0]?.locationState, 'unconfirmed')
    assert.equal(f.db.get(track.id)?.availability, 'removed')
    assert.equal(f.moves, 0)
  } finally {
    f.close()
  }
})

test('selected-song Trash bounds selection and refuses hard links, symbolic links and paused roots', async () => {
  const f = await fixture()
  try {
    const track = await f.add('safety.wav'),
      service = new TrackTrash(f.db, f.helper, () => {})
    await assert.rejects(service.preview(Array.from({ length: 1001 }, () => track)))
    await assert.rejects(
      service.preview([
        { id: track.id, revision: track.revision },
        { id: track.id, revision: track.revision },
      ]),
      /only once/
    )
    await link(track.path, path.join(f.root, 'hard.wav'))
    const hardlinkPlan = await service.preview([{ id: track.id, revision: track.revision }])
    assert.equal(hardlinkPlan.catalogOnly, 1)
    assert.match(hardlinkPlan.files[0]?.reason || '', /one hard link/)
    const linked = await f.add('symlink-target.wav')
    const shortcut = path.join(f.root, 'shortcut.wav')
    await symlink(linked.path, shortcut)
    f.db.db.prepare('UPDATE files SET path=? WHERE id=?').run(shortcut, linked.id)
    const symlinkPlan = await service.preview([{ id: linked.id, revision: 0 }])
    assert.equal(symlinkPlan.catalogOnly, 1)
    assert.match(symlinkPlan.files[0]?.reason || '', /symbolic links/)
    f.db.sourceEnabled(f.db.sources()[0]!.id, false)
    const pausedPlan = await service.preview([{ id: track.id, revision: track.revision }])
    assert.equal(pausedPlan.catalogOnly, 1)
    assert.match(pausedPlan.files[0]?.reason || '', /paused or unavailable/)
    assert.equal(f.moves, 0)
  } finally {
    f.close()
  }
})

test('restore never overwrites an occupied original path and preserves non-playable original availability', async () => {
  const f = await fixture()
  try {
    const track = await f.add('corrupt.mp3', 'corrupt'),
      before = await readFile(track.path)
    const service = new TrackTrash(f.db, f.helper, () => {}),
      plan = await service.preview([{ id: track.id, revision: track.revision }])
    const result = await service.start(plan.token)
    await writeFile(track.path, 'Replacement synthetic file must survive.')
    const failed = await service.restore(result.id)
    assert.equal(failed.status, 'partial')
    assert.match(failed.files[0]?.error || '', /occupied/)
    assert.equal(await readFile(track.path, 'utf8'), 'Replacement synthetic file must survive.')
    assert.equal(f.restores, 0)
    // Move the replacement aside rather than deleting any fixture through the product service.
    await rename(track.path, path.join(f.root, 'replacement.txt'))
    const restored = await service.restore(result.id)
    assert.equal(restored.status, 'restored')
    assert.equal(f.db.get(track.id)?.availability, 'corrupt')
    assert.deepEqual(await readFile(track.path), before)
  } finally {
    f.close()
  }
})

test('changed Trash contents are held while an unknown move is hidden without blocking independent files', async () => {
  const f = await fixture()
  try {
    const a = await f.add('changed-trash.wav'),
      service = new TrackTrash(f.db, f.helper, () => {})
    const moved = await service.start(
      (await service.preview([{ id: a.id, revision: a.revision }])).token
    )
    await writeFile(moved.files[0]!.trashPath!, 'Changed synthetic Trash contents.')
    const recovery = await service.restore(moved.id)
    assert.equal(recovery.status, 'partial')
    assert.match(recovery.files[0]?.error || '', /changed/)
    assert.equal(f.restores, 0)
    const b = await f.add('unknown.wav'),
      c = await f.add('remaining.wav')
    f.loseMoveResponse()
    const uncertain = await service.start(
      (
        await service.preview([
          { id: b.id, revision: b.revision },
          { id: c.id, revision: c.revision },
        ])
      ).token
    )
    assert.equal(uncertain.status, 'completed')
    assert.equal(uncertain.uncertain, 1)
    assert.equal(uncertain.removed, 1)
    assert.equal(uncertain.files[0]?.status, 'removed')
    assert.equal(uncertain.files[1]?.status, 'trashed')
    assert.equal(f.db.get(b.id)?.availability, 'removed')
    await assert.rejects(lstat(c.path), { code: 'ENOENT' })
    const restarted = new TrackTrash(f.db, f.helper, () => {})
    assert.equal(restarted.history().find(record => record.id === uncertain.id)?.uncertain, 1)
    const restoresBefore = f.restores
    restarted.restoreRemoved({ id: b.id, revision: f.db.get(b.id)!.revision })
    assert.equal(f.restores, restoresBefore)
    assert.equal(f.db.get(b.id)?.availability, 'available')
    new TrackTrash(f.db, f.helper, () => {})
    assert.equal(f.db.get(b.id)?.availability, 'available')
  } finally {
    f.close()
  }
})

test('interrupted journals mark in-flight operations uncertain and never repeat them', async () => {
  const f = await fixture()
  try {
    const track = await f.add('interrupted.wav'),
      service = new TrackTrash(f.db, f.helper, () => {})
    const moved = await service.start(
      (await service.preview([{ id: track.id, revision: track.revision }])).token
    )
    const journalPath = path.join(f.db.directory, 'track-trash', moved.id + '.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    journal.status = 'running'
    journal.entries[0].status = 'moving'
    await writeFile(journalPath, JSON.stringify(journal))
    const restarted = new TrackTrash(f.db, f.helper, () => {}),
      record = restarted.history()[0]
    assert.equal(record?.status, 'interrupted')
    assert.equal(record?.uncertain, 1)
    assert.equal(f.moves, 1)
    const recovery = await restarted.restore(moved.id)
    assert.equal(recovery.status, 'partial')
    assert.equal(f.restores, 0)
    await assert.rejects(service.preview([{ id: 'arbitrary', revision: 0 }] as TrackTrashChange[]))
  } finally {
    f.close()
  }
})

test('a permission failure in the middle hides only that catalog entry and still moves the third file', async () => {
  const f = await fixture()
  try {
    const a = await f.add('first.wav'),
      b = await f.add('denied.wav'),
      c = await f.add('last.wav')
    const original = await readFile(b.path)
    f.deny(b.path)
    const service = new TrackTrash(f.db, f.helper, () => {})
    const result = await service.start(
      (await service.preview([a, b, c].map(({ id, revision }) => ({ id, revision })))).token
    )
    assert.equal(result.status, 'completed')
    assert.equal(result.moved, 2)
    assert.equal(result.removed, 1)
    assert.equal(result.uncertain, 0)
    assert.equal(result.files[1]?.locationState, 'original-kept')
    assert.match(result.files[1]?.reason || '', /permission denied/)
    assert.deepEqual(await readFile(b.path), original)
    assert.equal(f.db.get(a.id)?.availability, 'trashed')
    assert.equal(f.db.get(b.id)?.availability, 'removed')
    assert.equal(f.db.get(c.id)?.availability, 'trashed')
    assert.equal(f.moves, 2)
    const partial = await service.restore(result.id, [c.id])
    assert.equal(partial.files.find(file => file.id === c.id)?.status, 'restored')
    assert.equal(f.db.get(a.id)?.availability, 'trashed')
    assert.equal(f.db.get(b.id)?.availability, 'removed')
    assert.equal(f.db.get(c.id)?.availability, 'available')
  } finally {
    f.close()
  }
})

test('preview-blocked files become disclosed catalog-only removals and never upgrade to a physical move', async () => {
  const f = await fixture()
  try {
    const a = await f.add('hardlinked.wav'),
      alias = path.join(f.root, 'other-hardlink.wav')
    await link(a.path, alias)
    // Register the post-link stat, then the one-hard-link rule alone blocks it.
    const updated = await f.inspect(a.path)
    f.db.db.prepare('UPDATE files SET signature=? WHERE id=?').run(signature(updated), a.id)
    const service = new TrackTrash(f.db, f.helper, () => {}),
      plan = await service.preview([{ id: a.id, revision: 0 }])
    assert.equal(plan.catalogOnly, 1)
    assert.equal(plan.files[0]?.action, 'remove-from-library')
    const result = await service.start(plan.token)
    assert.equal(result.removed, 1)
    assert.equal(result.moved, 0)
    assert.equal(result.files[0]?.locationState, 'original-kept')
    assert.equal(f.moves, 0)
    service.restoreRemoved({ id: a.id, revision: f.db.get(a.id)!.revision })
    new TrackTrash(f.db, f.helper, () => {})
    assert.equal(f.db.get(a.id)?.availability, 'available')
    assert.equal(service.history()[0]?.removed, 1)
    assert.equal(service.history()[0]?.restored, 1)
  } finally {
    f.close()
  }
})

test('legacy failed and uncertain entries reconcile once while pending entries and explicit catalog restoration remain intact', async () => {
  const f = await fixture()
  try {
    const failed = await f.add('legacy-failed.wav'),
      pending = await f.add('never-attempted.wav')
    f.deny(failed.path)
    const service = new TrackTrash(f.db, f.helper, () => {})
    const result = await service.start(
      (await service.preview([{ id: failed.id, revision: 0 }])).token
    )
    f.db.restoreToLibrary({
      id: failed.id,
      revision: f.db.get(failed.id)!.revision,
    })
    const journalPath = path.join(f.db.directory, 'track-trash', result.id + '.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    journal.status = 'partial'
    journal.entries[0].status = 'failed'
    journal.entries[0].error = 'Legacy native permission error'
    for (const key of ['action', 'locationState', 'removedAt', 'catalogRestoredAt', 'reason'])
      delete journal.entries[0][key]
    const pendingRow = f.db.db.prepare('SELECT * FROM files WHERE id=?').get(pending.id) as any
    journal.entries.push({
      ...journal.entries[0],
      id: pending.id,
      path: pending.path,
      title: 'never-attempted.wav',
      revision: 0,
      status: 'pending',
      error: undefined,
      physicalKey: pendingRow.physicalKey,
      signature: pendingRow.signature,
      size: pendingRow.size,
      expected: await f.inspect(pending.path),
    })
    await writeFile(journalPath, JSON.stringify(journal))
    const nativeForbidden = {
      inspect() {
        throw Error('Startup must be DB-only.')
      },
      call() {
        throw Error('Startup must not move files.')
      },
    } as unknown as NativeHelper
    const restarted = new TrackTrash(f.db, nativeForbidden, () => {})
    assert.equal(f.db.get(failed.id)?.availability, 'removed')
    assert.equal(f.db.get(pending.id)?.availability, 'available')
    restarted.restoreRemoved({
      id: failed.id,
      revision: f.db.get(failed.id)!.revision,
    })
    new TrackTrash(f.db, nativeForbidden, () => {})
    assert.equal(f.db.get(failed.id)?.availability, 'available')
    assert.equal(f.db.get(pending.id)?.availability, 'available')
    const persisted = JSON.parse(await readFile(journalPath, 'utf8'))
    assert.equal(persisted.entries[0].status, 'restored')
    assert.ok(persisted.entries[0].catalogRestoredAt)
    assert.equal(persisted.entries[1].status, 'pending')
  } finally {
    f.close()
  }
})

test('a confirmed native restore with failed post-inspection can finish catalog recovery without a second file move', async () => {
  const f = await fixture()
  try {
    const track = await f.add('restore-gap.wav'),
      original = await readFile(track.path),
      service = new TrackTrash(f.db, f.helper, () => {})
    const moved = await service.start(
      (await service.preview([{ id: track.id, revision: 0 }])).token
    )
    f.failNextRestoredInspection()
    const first = await service.restore(moved.id, [track.id])
    assert.equal(first.status, 'partial')
    assert.equal(f.restores, 1)
    assert.equal(f.db.get(track.id)?.availability, 'trashed')
    assert.deepEqual(await readFile(track.path), original)
    const restarted = new TrackTrash(f.db, f.helper, () => {})
    const completed = await restarted.restore(moved.id, [track.id])
    assert.equal(completed.status, 'restored')
    assert.equal(f.restores, 1)
    assert.equal(f.db.get(track.id)?.availability, 'available')
    assert.deepEqual(await readFile(track.path), original)
  } finally {
    f.close()
  }
})

export { fixture as trackTrashFixture }

test('all-Junk preview freezes the complete active Junk scope and never includes other categories or hidden removals', async () => {
  const f = await fixture()
  try {
    const a = await f.add('junk-a.wav'),
      b = await f.add('junk-b.wav'),
      music = await f.add('practice.wav'),
      hidden = await f.add('hidden-junk.wav'),
      trashed = await f.add('old-trashed-junk.wav')
    for (const row of [a, b, hidden, trashed])
      f.db.db.prepare("UPDATE files SET category='_JUNK' WHERE id=?").run(row.id)
    f.db.db.prepare("UPDATE files SET category='Hip Hop' WHERE id=?").run(music.id)
    f.db.removeFromLibrary(
      { id: hidden.id, revision: 0 },
      'Synthetic earlier removal',
      'original-kept'
    )
    f.db.db.prepare("UPDATE files SET availability='trashed' WHERE id=?").run(trashed.id)
    const original = await readFile(music.path),
      hiddenBytes = await readFile(hidden.path),
      service = new TrackTrash(f.db, f.helper, () => {})
    const plan = await service.previewJunk()
    assert.equal(plan.scope, 'junk')
    assert.equal(plan.total, 2)
    assert.equal(plan.files.length, 2)
    assert.deepEqual(new Set(plan.files.map(file => file.id)), new Set([a.id, b.id]))
    assert.equal(f.moves, 0)
    assert.equal(
      (await readdir(path.join(f.db.directory, 'track-trash'))).filter(name =>
        name.endsWith('.json')
      ).length,
      0
    )
    await lstat(a.path)
    await lstat(b.path)
    const result = await service.start(plan.token)
    assert.equal(result.selected, 2)
    assert.equal(result.moved, 2)
    assert.equal(f.db.get(music.id)?.availability, 'available')
    assert.deepEqual(await readFile(music.path), original)
    assert.equal(f.db.get(hidden.id)?.availability, 'removed')
    assert.deepEqual(await readFile(hidden.path), hiddenBytes)
    await service.restore(result.id)
    assert.deepEqual(await readFile(music.path), original)
  } finally {
    f.close()
  }
})

test('all-Junk confirmation rejects category changes and new scope members even if revisions were not bumped', async () => {
  const f = await fixture()
  try {
    const a = await f.add('old-junk.wav'),
      b = await f.add('another-junk.wav'),
      newcomer = await f.add('new-junk.wav')
    for (const row of [a, b])
      f.db.db.prepare("UPDATE files SET category='_JUNK' WHERE id=?").run(row.id)
    const service = new TrackTrash(f.db, f.helper, () => {}),
      first = await service.previewJunk()
    f.db.db.prepare("UPDATE files SET category='Pop' WHERE id=?").run(a.id)
    await assert.rejects(service.start(first.token), /Junk membership|Junk changed/)
    assert.equal(f.moves, 0)
    const second = await service.previewJunk()
    f.db.db.prepare("UPDATE files SET category='_JUNK' WHERE id=?").run(newcomer.id)
    await assert.rejects(service.start(second.token), /Junk membership|Junk changed/)
    assert.equal(f.moves, 0)
    const third = await service.previewJunk()
    f.db.db.prepare('UPDATE files SET revision=revision+1 WHERE id=?').run(b.id)
    await assert.rejects(service.start(third.token), /Junk membership|Junk changed/)
    assert.equal(f.moves, 0)
    for (const row of [a, b, newcomer]) await lstat(row.path)
  } finally {
    f.close()
  }
})

test('all-Junk scope exceeds the selected-row limit without truncation or preview effects', async () => {
  const f = await fixture()
  try {
    const changes = []
    for (let index = 0; index < 1001; index++) {
      const file = await f.add(`Junk page ${index}.wav`)
      f.db.db.prepare("UPDATE files SET category='_JUNK' WHERE id=?").run(file.id)
      changes.push({ id: file.id, revision: file.revision })
    }
    const service = new TrackTrash(f.db, f.helper, () => {})
    await assert.rejects(service.preview(changes))
    const plan = await service.previewJunk()
    assert.equal(plan.total, 1001)
    assert.equal(plan.files.length, 1001)
    assert.equal(new Set(plan.files.map(file => file.id)).size, 1001)
    assert.equal(f.moves, 0)
    assert.equal((await readdir(path.join(f.db.directory, 'track-trash'))).length, 0)
  } finally {
    f.close()
  }
})

test('all-Junk overflow is explicit and refuses before native preflight or a partial plan', async () => {
  const f = await fixture()
  try {
    const source = f.db.sources()[0]!
    f.db.db
      .prepare(
        `WITH RECURSIVE generated(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM generated WHERE n<10001)
      INSERT INTO files(id,physicalKey,path,filename,sourceId,signature,title,size,availability,addedAt,updatedAt,category)
      SELECT '00000000-0000-4000-8000-'||printf('%012d',n),'synthetic-cap-'||n,?||'/overflow-'||n||'.wav','overflow-'||n||'.wav',?,'synthetic','Synthetic overflow',1,'available','2026-10-17T00:00:00.000Z','2026-10-17T00:00:00.000Z','_JUNK' FROM generated`
      )
      .run(f.root, source.id)
    let calls = 0
    const helper = {
      inspect() {
        calls++
        throw Error('Overflow must stop before inspection.')
      },
      call() {
        calls++
        throw Error('Overflow must not move anything.')
      },
    } as unknown as NativeHelper
    const service = new TrackTrash(f.db, helper, () => {})
    await assert.rejects(service.previewJunk(), /more than 10,000 active files/)
    assert.equal(calls, 0)
    assert.equal(f.moves, 0)
    assert.equal((await readdir(path.join(f.db.directory, 'track-trash'))).length, 0)
  } finally {
    f.close()
  }
})

test('a category change during an all-Junk batch skips that item and continues other independent Junk files', async () => {
  const f = await fixture()
  try {
    const files = [
      await f.add('run-junk-a.wav'),
      await f.add('run-junk-b.wav'),
      await f.add('run-junk-c.wav'),
    ]
    for (const file of files)
      f.db.db.prepare("UPDATE files SET category='_JUNK' WHERE id=?").run(file.id)
    const ordered = [...files].sort((a, b) => a.id.localeCompare(b.id))
    let changed = false
    const service = new TrackTrash(f.db, f.helper, () => {
      if (!changed && f.moves === 1) {
        changed = true
        f.db.db.prepare("UPDATE files SET category='Pop' WHERE id=?").run(ordered[1]!.id)
      }
    })
    const result = await service.start((await service.previewJunk()).token)
    assert.equal(result.moved, 2)
    assert.equal(result.failed, 1)
    assert.equal(f.db.get(ordered[1]!.id)?.availability, 'available')
    await lstat(ordered[1]!.path)
    assert.equal(f.db.get(ordered[1]!.id)?.category, 'Pop')
    assert.equal(f.db.get(ordered[2]!.id)?.availability, 'trashed')
  } finally {
    f.close()
  }
})

test('metadata-only Trash ctime drift restores against the original pre-move SHA without rewriting saved identity evidence', async () => {
  const f = await fixture()
  try {
    const track = await f.add('ctime-only.wav'),
      bytes = Buffer.alloc(3 * 1024 * 1024 + 137, 0x5a)
    bytes[bytes.length - 1] = 0x17
    await writeFile(track.path, bytes)
    const updated = await f.inspect(track.path)
    f.db.db
      .prepare('UPDATE files SET signature=?,size=? WHERE id=?')
      .run(signature(updated), updated.size, track.id)
    const service = new TrackTrash(f.db, f.helper, () => {}),
      plan = await service.preview([{ id: track.id, revision: 0 }])
    assert.equal(f.moves, 0)
    assert.equal(
      (await readdir(path.join(f.db.directory, 'track-trash'))).filter(name =>
        name.endsWith('.json')
      ).length,
      0
    )
    const moved = await service.start(plan.token),
      journalPath = path.join(f.db.directory, 'track-trash', moved.id + '.json')
    const before = JSON.parse(await readFile(journalPath, 'utf8')),
      trashPath = moved.files[0]!.trashPath!
    assert.equal(before.entries[0].originalSHA256, createHash('sha256').update(bytes).digest('hex'))
    const originalExpected = before.entries[0].trashExpected
    await chmod(trashPath, 0o640)
    const changed = await f.inspect(trashPath)
    assert.notEqual(changed.ctime, originalExpected.ctime)
    assert.equal(changed.mtime, originalExpected.mtime)
    assert.equal(physicalKey(changed), physicalKey(originalExpected))
    const restored = await service.restore(moved.id)
    assert.equal(restored.status, 'restored')
    assert.equal(f.restores, 1)
    assert.deepEqual(await readFile(track.path), bytes)
    const after = JSON.parse(await readFile(journalPath, 'utf8'))
    assert.deepEqual(after.entries[0].trashExpected, originalExpected)
    assert.equal(after.entries[0].originalSHA256, before.entries[0].originalSHA256)
  } finally {
    f.close()
  }
})

test('same-size content edits with restored mtime cannot use ctime drift to bypass the original SHA', async () => {
  const f = await fixture()
  try {
    const track = await f.add('stale-sha.wav'),
      fixed = new Date('2020-01-01T00:00:00.000Z')
    await utimes(track.path, fixed, fixed)
    const info = await f.inspect(track.path)
    f.db.db
      .prepare('UPDATE files SET signature=?,physicalKey=? WHERE id=?')
      .run(signature(info), physicalKey(info), track.id)
    const original = await readFile(track.path),
      service = new TrackTrash(f.db, f.helper, () => {}),
      moved = await service.start((await service.preview([{ id: track.id, revision: 0 }])).token),
      trashPath = moved.files[0]!.trashPath!
    const journalPath = path.join(f.db.directory, 'track-trash', moved.id + '.json'),
      journal = JSON.parse(await readFile(journalPath, 'utf8'))
    const changed = Buffer.from(original)
    changed[0] = changed[0]! ^ 0xff
    await writeFile(trashPath, changed)
    await utimes(trashPath, fixed, fixed)
    const inspected = await f.inspect(trashPath)
    assert.equal(inspected.mtime, journal.entries[0].trashExpected.mtime)
    assert.equal(inspected.size, original.length)
    assert.notEqual(inspected.ctime, journal.entries[0].trashExpected.ctime)
    const refused = await service.restore(moved.id)
    assert.equal(refused.status, 'partial')
    assert.equal(f.restores, 0)
    assert.equal(f.db.get(track.id)?.availability, 'trashed')
    assert.match(refused.files[0]?.error || '', /contents differ from the original/)
    assert.deepEqual(await readFile(trashPath), changed)
    assert.equal(
      JSON.parse(await readFile(journalPath, 'utf8')).entries[0].originalSHA256,
      journal.entries[0].originalSHA256
    )
  } finally {
    f.close()
  }
})

test('legacy journals without an original SHA retain strict ctime checks even for unchanged bytes', async () => {
  const f = await fixture()
  try {
    const track = await f.add('legacy-ctime.wav'),
      service = new TrackTrash(f.db, f.helper, () => {}),
      moved = await service.start((await service.preview([{ id: track.id, revision: 0 }])).token),
      trashPath = moved.files[0]!.trashPath!
    const journalPath = path.join(f.db.directory, 'track-trash', moved.id + '.json'),
      journal = JSON.parse(await readFile(journalPath, 'utf8'))
    delete journal.entries[0].originalSHA256
    await writeFile(journalPath, JSON.stringify(journal))
    await chmod(trashPath, 0o640)
    const result = await service.restore(moved.id)
    assert.equal(result.status, 'partial')
    assert.equal(f.restores, 0)
    assert.match(result.files[0]?.error || '', /older batch has no original content proof/)
  } finally {
    f.close()
  }
})

test(
  'preview does not hash file contents and an explicit confirmed hash-read failure leaves the original and continues',
  {
    skip: process.getuid?.() === 0 ? 'Root can bypass fixture file read permissions.' : false,
  },
  async () => {
    const f = await fixture()
    let blockedPath = ''
    try {
      const blocked = await f.add('unreadable-original.wav'),
        next = await f.add('readable-next.wav')
      blockedPath = blocked.path
      await chmod(blocked.path, 0o000)
      const info = await f.inspect(blocked.path)
      f.db.db.prepare('UPDATE files SET signature=? WHERE id=?').run(signature(info), blocked.id)
      const service = new TrackTrash(f.db, f.helper, () => {}),
        plan = await service.preview([
          { id: blocked.id, revision: 0 },
          { id: next.id, revision: 0 },
        ])
      assert.equal(plan.catalogOnly, 0)
      assert.equal(f.moves, 0)
      const result = await service.start(plan.token)
      assert.equal(result.removed, 1)
      assert.equal(result.moved, 1)
      assert.equal(result.files[0]?.locationState, 'original-kept')
      assert.match(result.files[0]?.reason || '', /EACCES|permission denied/i)
      assert.equal(f.db.get(next.id)?.availability, 'trashed')
      const journal = JSON.parse(
        await readFile(path.join(f.db.directory, 'track-trash', result.id + '.json'), 'utf8')
      )
      assert.equal(journal.entries[0].originalSHA256, undefined)
      assert.match(journal.entries[1].originalSHA256, /^[a-f0-9]{64}$/)
    } finally {
      if (blockedPath) await chmod(blockedPath, 0o600)
      f.close()
    }
  }
)

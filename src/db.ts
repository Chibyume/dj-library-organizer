import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  chmodSync,
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs'
import path from 'node:path'
import { stablePhysicalKey, stableVolume } from './file-identity'
import type { OrganizationTag } from './organization-types'
import type {
  Category,
  LibraryPage,
  LibraryQuery,
  ScanProgress,
  Source,
  Summary,
  Track,
  Availability,
} from './shared'

export class LibraryDB {
  readonly db: Database.Database
  private identityBackupMade = false
  private journalIdentityCache: {
    fingerprint: string
    ids: Set<string>
  } | null = null
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.db = new Database(path.join(directory, 'library.sqlite'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version > 8)
      throw new Error('This database was created by a newer app. Use the newer app to open it.')
    if (version === 0)
      this.db.transaction(() => {
        this.db.exec(`
        CREATE TABLE sources(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,label TEXT NOT NULL,lastScan TEXT,status TEXT NOT NULL DEFAULT 'ready',demo INTEGER NOT NULL DEFAULT 0,broad INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE files(id TEXT PRIMARY KEY,physicalKey TEXT NOT NULL UNIQUE,path TEXT NOT NULL,filename TEXT NOT NULL,sourceId TEXT NOT NULL REFERENCES sources(id),signature TEXT NOT NULL,artist TEXT,title TEXT,bpm REAL,year INTEGER,genre TEXT,duration REAL,format TEXT,bitrate REAL,sampleRate INTEGER,key TEXT,size INTEGER NOT NULL,category TEXT,review TEXT NOT NULL DEFAULT 'Needs Manual Classification',availability TEXT NOT NULL,addedAt TEXT NOT NULL,updatedAt TEXT NOT NULL,manual INTEGER NOT NULL DEFAULT 0,metadataError TEXT,revision INTEGER NOT NULL DEFAULT 0,tags TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE locations(fileId TEXT NOT NULL REFERENCES files(id),sourceId TEXT NOT NULL REFERENCES sources(id),path TEXT NOT NULL,seenScan TEXT,available INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(sourceId,path));
        CREATE TABLE scans(id TEXT PRIMARY KEY,kind TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE scan_queue(scanId TEXT NOT NULL REFERENCES scans(id),sourceId TEXT NOT NULL REFERENCES sources(id),path TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scanId,sourceId,path));
        CREATE TABLE decisions(id TEXT PRIMARY KEY,fileId TEXT NOT NULL REFERENCES files(id),field TEXT NOT NULL,oldValue TEXT,newValue TEXT,createdAt TEXT NOT NULL,revision INTEGER NOT NULL);
        CREATE TABLE tag_evidence(id TEXT PRIMARY KEY,fileId TEXT NOT NULL REFERENCES files(id),signature TEXT NOT NULL,valuesJson TEXT NOT NULL,readAt TEXT NOT NULL);
        CREATE INDEX file_source ON files(sourceId); CREATE INDEX file_category ON files(category); CREATE INDEX file_review ON files(review); CREATE INDEX file_added ON files(addedAt); CREATE INDEX locations_instance ON locations(fileId);
        PRAGMA user_version = 1;
      `)
      })()
    if (version < 2) {
      if (version === 1) {
        const backup = path.join(directory, `before-schema-2-${randomUUID()}.sqlite`)
        this.db.prepare('VACUUM INTO ?').run(backup)
        chmodSync(backup, 0o600)
      }
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE sources ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
          CREATE TABLE rb_snapshots(id TEXT PRIMARY KEY,sourcePath TEXT NOT NULL,importedAt TEXT NOT NULL,modifiedAt TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,product TEXT NOT NULL,tracks INTEGER NOT NULL,playlists INTEGER NOT NULL,memberships INTEGER NOT NULL,dangling INTEGER NOT NULL,warnings TEXT NOT NULL,matchedAt TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0);
          CREATE UNIQUE INDEX rb_active ON rb_snapshots(active) WHERE active=1;
          CREATE TABLE rb_tracks(snapshotId TEXT NOT NULL REFERENCES rb_snapshots(id),trackKey TEXT NOT NULL,attrs TEXT NOT NULL,localPath TEXT,refKind TEXT NOT NULL,tempo TEXT NOT NULL,cues TEXT NOT NULL,PRIMARY KEY(snapshotId,trackKey));
          CREATE TABLE rb_nodes(snapshotId TEXT NOT NULL REFERENCES rb_snapshots(id),id TEXT NOT NULL,parentId TEXT,name TEXT NOT NULL,type TEXT NOT NULL,keyType TEXT,entries INTEGER NOT NULL,depth INTEGER NOT NULL,ordinal INTEGER NOT NULL,PRIMARY KEY(snapshotId,id));
          CREATE TABLE rb_memberships(snapshotId TEXT NOT NULL REFERENCES rb_snapshots(id),nodeId TEXT NOT NULL,ordinal INTEGER NOT NULL,ref TEXT NOT NULL,keyType TEXT NOT NULL,trackKey TEXT,PRIMARY KEY(snapshotId,nodeId,ordinal));
          CREATE INDEX rb_membership_track ON rb_memberships(snapshotId,trackKey);
          CREATE TABLE rb_matches(snapshotId TEXT NOT NULL REFERENCES rb_snapshots(id),trackKey TEXT NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,fileId TEXT,candidates TEXT NOT NULL,conflicts TEXT NOT NULL,PRIMARY KEY(snapshotId,trackKey));
          CREATE INDEX rb_match_file ON rb_matches(snapshotId,fileId);
          CREATE TABLE preview_evidence(fileId TEXT PRIMARY KEY REFERENCES files(id),signature TEXT NOT NULL,status TEXT NOT NULL,checkedAt TEXT NOT NULL,error TEXT);
          PRAGMA user_version=2;
        `)
      })()
    }
    if (version < 3) {
      if (version === 2) {
        const backup = path.join(directory, `before-schema-3-${randomUUID()}.sqlite`)
        this.db.prepare('VACUUM INTO ?').run(backup)
        chmodSync(backup, 0o600)
      }
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE classification_settings(id INTEGER PRIMARY KEY CHECK(id=1),automatic INTEGER NOT NULL DEFAULT 1,epoch INTEGER NOT NULL DEFAULT 0);
          INSERT INTO classification_settings(id) VALUES(1);
          CREATE TABLE classification_queue(fileId TEXT PRIMARY KEY REFERENCES files(id));
          CREATE TABLE classification_results(fileId TEXT PRIMARY KEY REFERENCES files(id),inputHash TEXT NOT NULL,result TEXT NOT NULL,computedAt TEXT NOT NULL,acknowledgedHash TEXT);
          CREATE TABLE classification_job(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
          CREATE TABLE classification_rules(id TEXT PRIMARY KEY,field TEXT NOT NULL,match TEXT NOT NULL,category TEXT NOT NULL,createdAt TEXT NOT NULL);
          CREATE TABLE era_years(fileId TEXT PRIMARY KEY REFERENCES files(id),year INTEGER NOT NULL,kind TEXT NOT NULL,note TEXT NOT NULL,signature TEXT NOT NULL,confirmedAt TEXT NOT NULL);
          CREATE TRIGGER classification_insert AFTER INSERT ON files BEGIN
            INSERT OR IGNORE INTO classification_queue VALUES(NEW.id);
            UPDATE classification_settings SET epoch=epoch+1 WHERE id=1;
          END;
          CREATE TRIGGER classification_evidence AFTER UPDATE ON files WHEN NEW.signature IS NOT OLD.signature OR NEW.genre IS NOT OLD.genre OR NEW.tags IS NOT OLD.tags OR NEW.title IS NOT OLD.title OR NEW.filename IS NOT OLD.filename OR NEW.availability IS NOT OLD.availability OR NEW.manual IS NOT OLD.manual OR (NEW.manual=1 AND (NEW.category IS NOT OLD.category OR NEW.review IS NOT OLD.review)) BEGIN
            INSERT OR IGNORE INTO classification_queue VALUES(NEW.id);
            UPDATE classification_settings SET epoch=epoch+1 WHERE id=1;
          END;
          CREATE TRIGGER classification_snapshot AFTER UPDATE OF active,matchedAt ON rb_snapshots BEGIN
            INSERT OR IGNORE INTO classification_queue SELECT id FROM files;
            UPDATE classification_settings SET epoch=epoch+1 WHERE id=1;
          END;
          PRAGMA user_version=3;
        `)
      })()
    }
    if (version < 4) {
      if (version > 0) {
        const backup = path.join(directory, `before-schema-4-${randomUUID()}.sqlite`)
        this.db.prepare('VACUUM INTO ?').run(backup)
        chmodSync(backup, 0o600)
      }
      this.db.transaction(() => {
        this.db.exec(`
        CREATE TABLE research_results(fileId TEXT NOT NULL REFERENCES files(id),provider TEXT NOT NULL,inputHash TEXT NOT NULL,signature TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(fileId,provider));
        CREATE INDEX research_cache ON research_results(provider,inputHash);
        CREATE TABLE research_approved(fileId TEXT PRIMARY KEY REFERENCES files(id),signature TEXT NOT NULL,inputHash TEXT NOT NULL,value TEXT NOT NULL,approvedAt TEXT NOT NULL);
        CREATE TABLE research_queue(fileId TEXT PRIMARY KEY REFERENCES files(id),provider TEXT NOT NULL,inputHash TEXT NOT NULL,signature TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending');
        CREATE TABLE research_job(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
        CREATE TRIGGER research_approved_insert AFTER INSERT ON research_approved BEGIN INSERT OR IGNORE INTO classification_queue VALUES(NEW.fileId);UPDATE classification_settings SET epoch=epoch+1 WHERE id=1;END;
        CREATE TRIGGER research_approved_update AFTER UPDATE ON research_approved BEGIN INSERT OR IGNORE INTO classification_queue VALUES(NEW.fileId);UPDATE classification_settings SET epoch=epoch+1 WHERE id=1;END;
        CREATE TRIGGER research_approved_delete AFTER DELETE ON research_approved BEGIN INSERT OR IGNORE INTO classification_queue VALUES(OLD.fileId);UPDATE classification_settings SET epoch=epoch+1 WHERE id=1;END;
        PRAGMA user_version=4;
      `)
      })()
    }
    if (version < 5) {
      if (version > 0) {
        const backup = path.join(directory, `before-schema-5-${randomUUID()}.sqlite`)
        this.db.prepare('VACUUM INTO ?').run(backup)
        chmodSync(backup, 0o600)
      }
      this.db.transaction(() => {
        this.db.exec(`
        CREATE TABLE file_hashes(fileId TEXT PRIMARY KEY REFERENCES files(id),signature TEXT NOT NULL,physicalKey TEXT NOT NULL,hash TEXT,error TEXT,checkedAt TEXT NOT NULL);
        CREATE INDEX file_hash_value ON file_hashes(hash);
        CREATE TABLE duplicate_job(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
        CREATE TABLE duplicate_decisions(groupKey TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,keeper TEXT,decidedAt TEXT NOT NULL);
        CREATE TABLE playlist_approvals(fileId TEXT PRIMARY KEY REFERENCES files(id),fingerprint TEXT NOT NULL,approvedAt TEXT NOT NULL);
        CREATE TABLE playlist_exports(id TEXT PRIMARY KEY,data TEXT NOT NULL,manifest TEXT NOT NULL);
        PRAGMA user_version=5;
      `)
      })()
    }
    if (version < 6) {
      if (version > 0) {
        const backup = path.join(directory, `before-schema-6-${randomUUID()}.sqlite`)
        this.db.prepare('VACUUM INTO ?').run(backup)
        chmodSync(backup, 0o600)
      }
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS automation_state(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL); PRAGMA user_version=6;`
      )
    }
    if (version < 7) {
      if (version > 0) {
        const backup = path.join(directory, `before-schema-7-${randomUUID()}.sqlite`)
        this.db.prepare('VACUUM INTO ?').run(backup)
        chmodSync(backup, 0o600)
      }
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS organization_tags(fileId TEXT NOT NULL REFERENCES files(id),groupName TEXT NOT NULL CHECK(groupName IN ('genre','version','use','familiarity')),value TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin IN ('automatic','manual')),PRIMARY KEY(fileId,groupName,value));
          CREATE INDEX IF NOT EXISTS organization_tag_filter ON organization_tags(groupName,value,fileId);
          CREATE TABLE IF NOT EXISTS organization_overrides(fileId TEXT NOT NULL REFERENCES files(id),groupName TEXT NOT NULL CHECK(groupName IN ('genre','version','use','familiarity')),value TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('add','remove')),PRIMARY KEY(fileId,groupName,value));
          CREATE TABLE IF NOT EXISTS library_playlists(id TEXT PRIMARY KEY,name TEXT NOT NULL,parentId TEXT REFERENCES library_playlists(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('folder','playlist')),createdAt TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS library_playlist_parent ON library_playlists(parentId);
          CREATE TABLE IF NOT EXISTS library_playlist_members(playlistId TEXT NOT NULL REFERENCES library_playlists(id) ON DELETE CASCADE,fileId TEXT NOT NULL REFERENCES files(id),ordinal INTEGER NOT NULL,PRIMARY KEY(playlistId,fileId));
          CREATE INDEX IF NOT EXISTS library_playlist_file ON library_playlist_members(fileId);
          CREATE TABLE IF NOT EXISTS organization_queue(fileId TEXT PRIMARY KEY REFERENCES files(id));
          INSERT OR IGNORE INTO organization_queue SELECT id FROM files WHERE availability!='trashed';
          CREATE TRIGGER IF NOT EXISTS organization_insert AFTER INSERT ON files BEGIN INSERT OR IGNORE INTO organization_queue VALUES(NEW.id);END;
          CREATE TRIGGER IF NOT EXISTS organization_evidence AFTER UPDATE ON files WHEN NEW.signature IS NOT OLD.signature OR NEW.genre IS NOT OLD.genre OR NEW.tags IS NOT OLD.tags OR NEW.title IS NOT OLD.title OR NEW.artist IS NOT OLD.artist OR NEW.duration IS NOT OLD.duration OR NEW.year IS NOT OLD.year OR NEW.filename IS NOT OLD.filename OR NEW.category IS NOT OLD.category OR NEW.availability IS NOT OLD.availability BEGIN INSERT OR IGNORE INTO organization_queue VALUES(NEW.id);END;
          CREATE TRIGGER IF NOT EXISTS organization_snapshot AFTER UPDATE OF active,matchedAt ON rb_snapshots BEGIN INSERT OR IGNORE INTO organization_queue SELECT id FROM files WHERE availability!='trashed';END;
          CREATE TRIGGER IF NOT EXISTS organization_research_insert AFTER INSERT ON research_approved BEGIN INSERT OR IGNORE INTO organization_queue VALUES(NEW.fileId);END;
          CREATE TRIGGER IF NOT EXISTS organization_research_update AFTER UPDATE ON research_approved BEGIN INSERT OR IGNORE INTO organization_queue VALUES(NEW.fileId);END;
          CREATE TRIGGER IF NOT EXISTS organization_research_delete AFTER DELETE ON research_approved BEGIN INSERT OR IGNORE INTO organization_queue VALUES(OLD.fileId);END;
          PRAGMA user_version=7;
        `)
      })()
    }
    if (version < 8) {
      if (version > 0) {
        const backup = path.join(directory, `before-schema-8-${randomUUID()}.sqlite`)
        this.db.prepare('VACUUM INTO ?').run(backup)
        chmodSync(backup, 0o600)
      }
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS library_removals(fileId TEXT PRIMARY KEY REFERENCES files(id),originalAvailability TEXT NOT NULL,removedAt TEXT NOT NULL,reason TEXT NOT NULL,locationState TEXT NOT NULL CHECK(locationState IN ('original-kept','unconfirmed')));
          CREATE TABLE IF NOT EXISTS library_removal_locations(fileId TEXT NOT NULL REFERENCES library_removals(fileId) ON DELETE CASCADE,sourceId TEXT NOT NULL,path TEXT NOT NULL,available INTEGER NOT NULL,PRIMARY KEY(fileId,sourceId,path));
          DROP TRIGGER IF EXISTS classification_snapshot;
          CREATE TRIGGER classification_snapshot AFTER UPDATE OF active,matchedAt ON rb_snapshots BEGIN
            INSERT OR IGNORE INTO classification_queue SELECT id FROM files WHERE availability NOT IN ('trashed','removed');
            UPDATE classification_settings SET epoch=epoch+1 WHERE id=1;
          END;
          DROP TRIGGER IF EXISTS organization_snapshot;
          CREATE TRIGGER organization_snapshot AFTER UPDATE OF active,matchedAt ON rb_snapshots BEGIN INSERT OR IGNORE INTO organization_queue SELECT id FROM files WHERE availability NOT IN ('trashed','removed');END;
          DELETE FROM classification_queue WHERE fileId IN (SELECT id FROM files WHERE availability IN ('trashed','removed'));
          DELETE FROM organization_queue WHERE fileId IN (SELECT id FROM files WHERE availability IN ('trashed','removed'));
          PRAGMA user_version=8;
        `)
      })()
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS file_path ON files(path); CREATE INDEX IF NOT EXISTS location_path ON locations(path); CREATE INDEX IF NOT EXISTS hidden_physical_volume ON files(physicalKey COLLATE NOCASE) WHERE availability IN ('trashed','removed');"
    )
    this.db.prepare("UPDATE scans SET status='interrupted' WHERE status='running'").run()
    this.db.prepare("UPDATE sources SET status='interrupted' WHERE status='scanning'").run()
  }
  close() {
    this.db.close()
  }
  async backup(destination: string) {
    await this.db.backup(destination)
  }
  addSource(root: string, demo = false, broad = false): Source {
    const existing = this.db.prepare('SELECT * FROM sources WHERE path=?').get(root) as
      Source | undefined
    if (!existing)
      this.db
        .prepare('INSERT INTO sources(id,path,label,demo,broad) VALUES(?,?,?,?,?)')
        .run(
          randomUUID(),
          root,
          demo ? 'Demo Library' : path.basename(root) || root,
          Number(demo),
          Number(broad)
        )
    else this.db.prepare('UPDATE sources SET enabled=1 WHERE id=?').run(existing.id)
    return this.sources().find(s => s.path === root)!
  }
  sources(): Source[] {
    return (
      this.db
        .prepare(
          "SELECT s.*,COUNT(DISTINCT CASE WHEN l.available=1 AND f.availability NOT IN ('trashed','removed') THEN l.fileId END) AS fileCount FROM sources s LEFT JOIN locations l ON l.sourceId=s.id LEFT JOIN files f ON f.id=l.fileId GROUP BY s.id ORDER BY s.demo,s.label COLLATE NOCASE"
        )
        .all() as (Omit<Source, 'demo' | 'broad' | 'enabled'> & {
        demo: number
        broad: number
        enabled: number
      })[]
    ).map(s => ({
      ...s,
      demo: Boolean(s.demo),
      broad: Boolean(s.broad),
      enabled: Boolean(s.enabled),
    }))
  }
  source(id: string) {
    return this.sources().find(s => s.id === id)
  }
  sourceEnabled(id: string, enabled: boolean) {
    if (!this.source(id)) throw new Error('Source not found.')
    this.db.prepare('UPDATE sources SET enabled=? WHERE id=?').run(Number(enabled), id)
  }
  previewEvidence(id: string, status: 'played' | 'failed', error: string | null) {
    this.db
      .prepare(
        'INSERT INTO preview_evidence SELECT id,signature,?,?,? FROM files WHERE id=? ON CONFLICT(fileId) DO UPDATE SET signature=excluded.signature,status=excluded.status,checkedAt=excluded.checkedAt,error=excluded.error'
      )
      .run(status, new Date().toISOString(), error, id)
  }
  get(id: string): Track | undefined {
    const row = this.db
      .prepare(
        'SELECT f.*,s.label AS sourceLabel FROM files f JOIN sources s ON s.id=f.sourceId WHERE f.id=?'
      )
      .get(id)
    return row ? this.track(row) : undefined
  }
  findPhysical(key: string) {
    return this.db
      .prepare('SELECT id,signature,path,availability FROM files WHERE physicalKey=?')
      .get(key) as
      | {
          id: string
          signature: string
          path: string
          availability: Availability
        }
      | undefined
  }
  /** A fresh native observation may rebind a stable volume identity, never a pathname alone. */
  resolvePhysical(key: string, filePath: string) {
    const exact = this.findPhysical(key)
    const stable = stablePhysicalKey(key),
      volume = stableVolume(key)
    const candidates = this.db
      .prepare('SELECT id,physicalKey,signature,path,availability,addedAt FROM files WHERE path=?')
      .all(filePath) as {
      id: string
      physicalKey: string
      signature: string
      path: string
      availability: Availability
      addedAt: string
    }[]
    const aliases = candidates.filter(row => stablePhysicalKey(row.physicalKey) === stable)
    if (exact && !aliases.some(row => row.id === exact.id)) {
      const row = this.db
        .prepare('SELECT id,physicalKey,signature,path,availability,addedAt FROM files WHERE id=?')
        .get(exact.id) as (typeof candidates)[number]
      aliases.push(row)
    }
    const hidden = volume
      ? (
          this.db
            .prepare(
              "SELECT id,physicalKey,availability FROM files WHERE availability IN ('trashed','removed') AND physicalKey LIKE ? AND physicalKey LIKE ?"
            )
            .all(volume + '|%', '%|' + key.split('|').slice(2).join('|')) as {
            id: string
            physicalKey: string
            availability: Availability
          }[]
        ).find(row => stablePhysicalKey(row.physicalKey) === stable)
      : aliases.find(row => ['trashed', 'removed'].includes(row.availability))
    if (hidden) {
      // Older orphan rows for an explicitly removed instance must not reappear
      // merely because its volume received a different device number.
      for (const row of aliases)
        if (!['trashed', 'removed'].includes(row.availability)) {
          const current = this.get(row.id)!
          this.removeFromLibrary(
            { id: row.id, revision: current.revision },
            'This physical file was already removed from the library.',
            'unconfirmed'
          )
        }
      return this.findPhysical(hidden.physicalKey)
    }
    if (!aliases.length) return undefined
    const protectedIds = aliases.length > 1 ? this.recoveryJournalIds() : new Set<string>()
    if (aliases.filter(row => protectedIds.has(row.id)).length > 1)
      throw new Error(
        'Multiple catalogue identities for this file are linked to saved Trash recovery history. Automatic consolidation was held; no files were moved.'
      )
    aliases.sort(
      (a, b) =>
        Number(protectedIds.has(b.id)) - Number(protectedIds.has(a.id)) ||
        a.addedAt.localeCompare(b.addedAt) ||
        a.id.localeCompare(b.id)
    )
    const winner = aliases[0]!
    if (aliases.length > 1 && !this.identityBackupMade) {
      const backup = path.join(
        this.directory,
        `before-identity-reconciliation-${randomUUID()}.sqlite`
      )
      this.db.prepare('VACUUM INTO ?').run(backup)
      chmodSync(backup, 0o600)
      this.identityBackupMade = true
    }
    this.db.transaction(() => {
      for (const alias of aliases.slice(1)) this.mergeIdentityAlias(winner.id, alias.id, key)
      if (winner.physicalKey !== key) {
        this.db
          .prepare('UPDATE files SET physicalKey=?,revision=revision+1 WHERE id=?')
          .run(key, winner.id)
        this.db.prepare('DELETE FROM playlist_approvals WHERE fileId=?').run(winner.id)
        this.db.prepare('INSERT OR IGNORE INTO classification_queue VALUES(?)').run(winner.id)
        this.db.prepare('INSERT OR IGNORE INTO organization_queue VALUES(?)').run(winner.id)
      }
    })()
    return this.findPhysical(key)
  }
  private recoveryJournalIds(): Set<string> {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
    const files: {
      path: string
      device: bigint
      inode: bigint
      size: bigint
      mtime: bigint
      ctime: bigint
    }[] = []
    let total = 0
    try {
      for (const folder of ['track-trash', 'duplicate-cleanup']) {
        const directory = path.join(this.directory, folder)
        let info
        try {
          info = lstatSync(directory)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw error
        }
        if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory)
          throw Error('Recovery directory is not a safe local directory.')
        const names = readdirSync(directory)
        if (names.length > 2000)
          throw Error('Recovery directory exceeds its bounded history limit.')
        for (const name of names.sort()) {
          if (!name.endsWith('.json')) continue
          if (!uuid.test(name.slice(0, -5))) throw Error('Unknown recovery journal name.')
          const filePath = path.join(directory, name),
            stat = lstatSync(filePath, { bigint: true })
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1n ||
            stat.size > 4n * 1024n * 1024n
          )
            throw Error('Recovery journal is not a bounded regular file.')
          total += Number(stat.size)
          if (total > 16 * 1024 * 1024 || files.length >= 1000)
            throw Error('Recovery journals exceed the bounded identity-check limit.')
          files.push({
            path: filePath,
            device: stat.dev,
            inode: stat.ino,
            size: stat.size,
            mtime: stat.mtimeNs,
            ctime: stat.ctimeNs,
          })
        }
      }
      const fingerprint = JSON.stringify(
        files.map(file => [
          file.path,
          String(file.device),
          String(file.inode),
          String(file.size),
          String(file.mtime),
          String(file.ctime),
        ])
      )
      if (this.journalIdentityCache?.fingerprint === fingerprint)
        return this.journalIdentityCache.ids
      const ids = new Set<string>()
      for (const file of files) {
        const fd = openSync(
          file.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        )
        try {
          const matches = (stat: BigIntStats) =>
            stat.isFile() &&
            stat.nlink === 1n &&
            stat.dev === file.device &&
            stat.ino === file.inode &&
            stat.size === file.size
          const first = fstatSync(fd, { bigint: true })
          if (
            !matches(first) ||
            first.nlink !== 1n ||
            first.mtimeNs !== file.mtime ||
            first.ctimeNs !== file.ctime
          )
            throw Error('Recovery journal changed during identity checking.')
          const record = JSON.parse(readFileSync(fd, 'utf8'))
          if (
            record?.version !== 1 ||
            !Array.isArray(record.entries) ||
            !record.entries.length ||
            record.entries.some(
              (entry: any) =>
                !uuid.test(entry?.id || entry?.file?.id || '') || typeof entry.status !== 'string'
            )
          )
            throw Error('Malformed recovery journal.')
          const stack: { value: unknown; depth: number }[] = [{ value: record, depth: 0 }]
          let visited = 0
          while (stack.length) {
            const { value, depth } = stack.pop()!
            if (++visited > 200000 || depth > 32)
              throw Error('Recovery journal exceeds bounded structure limits.')
            if (typeof value === 'string' && uuid.test(value)) ids.add(value)
            else if (value && typeof value === 'object')
              for (const child of Object.values(value))
                stack.push({ value: child, depth: depth + 1 })
          }
          const last = fstatSync(fd, { bigint: true }),
            current = lstatSync(file.path, { bigint: true })
          if (
            !matches(last) ||
            !matches(current) ||
            last.mtimeNs !== file.mtime ||
            last.ctimeNs !== file.ctime ||
            current.mtimeNs !== file.mtime ||
            current.ctimeNs !== file.ctime
          )
            throw Error('Recovery journal changed during identity checking.')
        } finally {
          closeSync(fd)
        }
      }
      this.journalIdentityCache = { fingerprint, ids }
      return ids
    } catch (error) {
      throw new Error(
        'Could not safely check saved Trash recovery history. Catalogue identity consolidation was held. ' +
          (error instanceof Error ? error.message : String(error))
      )
    }
  }
  private mergeIdentityAlias(winnerId: string, aliasId: string, key: string) {
    const winner = this.get(winnerId)! as Track & { signature: string },
      alias = this.get(aliasId)!
    if (alias.manual && !winner.manual)
      this.db
        .prepare('UPDATE files SET manual=1,category=?,review=?,revision=revision+1 WHERE id=?')
        .run(alias.category, alias.review, winnerId)
    else if (
      alias.manual &&
      winner.manual &&
      (alias.category !== winner.category || alias.review !== winner.review)
    )
      this.db
        .prepare("UPDATE files SET review='Conflicting Evidence',revision=revision+1 WHERE id=?")
        .run(winnerId)
    // Preserve the complete pre-merge catalogue in the private backup above;
    // retain every decision/evidence record and union the user's memberships.
    for (const table of ['decisions', 'tag_evidence', 'locations'])
      this.db.prepare(`UPDATE ${table} SET fileId=? WHERE fileId=?`).run(winnerId, aliasId)
    this.db
      .prepare(
        'INSERT OR IGNORE INTO library_playlist_members SELECT playlistId,?,ordinal FROM library_playlist_members WHERE fileId=?'
      )
      .run(winnerId, aliasId)
    this.db.prepare('DELETE FROM library_playlist_members WHERE fileId=?').run(aliasId)
    this.db
      .prepare(
        "INSERT INTO organization_tags SELECT ?,groupName,value,origin FROM organization_tags WHERE fileId=? ON CONFLICT(fileId,groupName,value) DO UPDATE SET origin=CASE WHEN organization_tags.origin='manual' OR excluded.origin='manual' THEN 'manual' ELSE 'automatic' END"
      )
      .run(winnerId, aliasId)
    this.db
      .prepare(
        'INSERT OR IGNORE INTO organization_overrides SELECT ?,groupName,value,action FROM organization_overrides WHERE fileId=?'
      )
      .run(winnerId, aliasId)
    for (const table of ['organization_tags', 'organization_overrides'])
      this.db.prepare(`DELETE FROM ${table} WHERE fileId=?`).run(aliasId)
    const shared: Record<string, string> = {
      classification_results: 'inputHash,result,computedAt,acknowledgedHash',
      research_results: 'provider,inputHash,signature,result',
      research_approved: 'signature,inputHash,value,approvedAt',
      research_queue: 'provider,inputHash,signature,input,state',
      era_years: 'year,kind,note,signature,confirmedAt',
      preview_evidence: 'signature,status,checkedAt,error',
    }
    for (const [table, columns] of Object.entries(shared)) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO ${table}(fileId,${columns}) SELECT ?,${columns} FROM ${table} WHERE fileId=?`
        )
        .run(winnerId, aliasId)
      this.db.prepare(`DELETE FROM ${table} WHERE fileId=?`).run(aliasId)
    }
    const hash = this.db
      .prepare(
        'SELECT signature,physicalKey,hash,error,checkedAt FROM file_hashes WHERE fileId=? AND physicalKey=? AND hash IS NOT NULL'
      )
      .get(aliasId, key) as
      | {
          signature: string
          physicalKey: string
          hash: string
          error: string | null
          checkedAt: string
        }
      | undefined
    if (hash && hash.signature === winner.signature)
      this.db
        .prepare(
          'INSERT INTO file_hashes VALUES(?,?,?,?,?,?) ON CONFLICT(fileId) DO UPDATE SET signature=excluded.signature,physicalKey=excluded.physicalKey,hash=excluded.hash,error=excluded.error,checkedAt=excluded.checkedAt'
        )
        .run(winnerId, hash.signature, hash.physicalKey, hash.hash, hash.error, hash.checkedAt)
    this.db.prepare('DELETE FROM file_hashes WHERE fileId=?').run(aliasId)
    for (const table of ['classification_queue', 'organization_queue', 'playlist_approvals'])
      this.db.prepare(`DELETE FROM ${table} WHERE fileId=?`).run(aliasId)
    this.db.prepare('DELETE FROM playlist_approvals WHERE fileId=?').run(winnerId)
    this.db.prepare('UPDATE duplicate_decisions SET keeper=? WHERE keeper=?').run(winnerId, aliasId)
    this.db.prepare('UPDATE rb_matches SET fileId=? WHERE fileId=?').run(winnerId, aliasId)
    const matches = this.db
      .prepare('SELECT snapshotId,trackKey,candidates FROM rb_matches WHERE candidates LIKE ?')
      .all('%' + aliasId + '%') as {
      snapshotId: string
      trackKey: string
      candidates: string
    }[]
    for (const match of matches) {
      const ids = JSON.parse(match.candidates) as string[]
      this.db
        .prepare('UPDATE rb_matches SET candidates=? WHERE snapshotId=? AND trackKey=?')
        .run(
          JSON.stringify([...new Set(ids.map(id => (id === aliasId ? winnerId : id)))]),
          match.snapshotId,
          match.trackKey
        )
    }
    this.db.prepare('DELETE FROM files WHERE id=?').run(aliasId)
    this.db.prepare('INSERT OR IGNORE INTO classification_queue VALUES(?)').run(winnerId)
    this.db.prepare('INSERT OR IGNORE INTO organization_queue VALUES(?)').run(winnerId)
  }
  track(row: unknown): Track {
    const r = row as Omit<Track, 'tags' | 'manual'> & {
      tags: string
      manual: number
    }
    const organizationTags = this.db
      .prepare(
        "SELECT groupName AS 'group',value,origin FROM organization_tags WHERE fileId=? ORDER BY groupName,value COLLATE NOCASE"
      )
      .all(r.id) as OrganizationTag[]
    return {
      ...r,
      tags: JSON.parse(r.tags),
      manual: Boolean(r.manual),
      organizationTags,
    }
  }
  list(q: LibraryQuery): LibraryPage {
    const clauses: string[] = [
      q.view === 'trash'
        ? "f.availability='trashed'"
        : "f.availability NOT IN ('trashed','removed')",
    ]
    const values: unknown[] = []
    if (q.search) {
      clauses.push(
        "(COALESCE(f.artist,'') LIKE ? ESCAPE '\\' OR COALESCE(f.title,'') LIKE ? ESCAPE '\\' OR f.filename LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM organization_tags ot WHERE ot.fileId=f.id AND ot.value LIKE ? ESCAPE '\\'))"
      )
      const s = '%' + q.search.replace(/[\\%_]/g, '\\$&') + '%'
      values.push(s, s, s, s)
    }
    if (q.view === 'new') clauses.push("f.manual=0 AND f.review!='Excluded'")
    if (q.view === 'review') clauses.push("f.review NOT IN ('Ready for Approval','Excluded')")
    if (q.view === 'unavailable') clauses.push("f.availability!='available'")
    if (q.view === 'source') {
      clauses.push('EXISTS(SELECT 1 FROM locations l WHERE l.fileId=f.id AND l.sourceId=?)')
      values.push(q.value || '')
    }
    if (q.view === 'category') {
      clauses.push('f.category=?')
      values.push(q.value || '')
    }
    if (q.view === 'practice') {
      clauses.push("f.availability='available'")
      if (q.value === 'unsorted') {
        clauses.push(
          "NOT EXISTS(SELECT 1 FROM organization_tags ot WHERE ot.fileId=f.id AND ot.groupName='genre')"
        )
      } else if (q.value) {
        clauses.push(
          "EXISTS(SELECT 1 FROM organization_tags ot WHERE ot.fileId=f.id AND ot.groupName='genre' AND ot.value=?)"
        )
        values.push(q.value)
      }
    }
    if (q.view === 'tag') {
      clauses.push("f.availability='available'")
      const separator = (q.value || '').indexOf(':')
      clauses.push(
        'EXISTS(SELECT 1 FROM organization_tags ot WHERE ot.fileId=f.id AND ot.groupName=? AND ot.value=?)'
      )
      values.push((q.value || '').slice(0, separator), (q.value || '').slice(separator + 1))
    }
    if (q.view === 'playlist') {
      clauses.push(
        'f.id IN (WITH RECURSIVE tree(id) AS (SELECT id FROM library_playlists WHERE id=? UNION ALL SELECT p.id FROM library_playlists p JOIN tree t ON p.parentId=t.id) SELECT m.fileId FROM library_playlist_members m JOIN tree t ON m.playlistId=t.id)'
      )
      values.push(q.value || '')
    }
    const columns: Record<string, string> = {
      artist: 'artist',
      title: 'title',
      bpm: 'bpm',
      year: 'year',
      genre: 'genre',
      category: 'category',
      review: 'review',
      duration: 'duration',
      filename: 'filename',
      availability: 'availability',
      addedAt: 'addedAt',
    }
    const col = columns[q.sort] || 'artist'
    const dir = q.direction === 'desc' ? 'DESC' : 'ASC'
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''
    const total = (
      this.db.prepare('SELECT COUNT(*) n FROM files f' + where).get(...values) as { n: number }
    ).n
    const rows = this.db
      .prepare(
        `SELECT f.*,s.label AS sourceLabel FROM files f JOIN sources s ON s.id=f.sourceId${where} ORDER BY (f.${col} IS NULL OR f.${col}='') ASC,f.${col} COLLATE NOCASE ${dir},f.id LIMIT ? OFFSET ?`
      )
      .all(...values, q.limit, q.offset)
    return { tracks: rows.map(row => this.track(row)), total }
  }
  summary(): Summary {
    const counts = this.db
      .prepare(
        "SELECT COUNT(*) files,COALESCE(SUM(category IS NOT NULL AND review!='Excluded'),0) classified,COALESCE(SUM(review NOT IN ('Ready for Approval','Excluded')),0) review,COALESCE(SUM(availability!='available'),0) unavailable,COALESCE(SUM(CASE WHEN availability='available' THEN size ELSE 0 END),0) bytes FROM files WHERE availability NOT IN ('trashed','removed')"
      )
      .get() as Omit<Summary, 'lastScan' | 'categoryCounts'>
    const last = this.db
      .prepare('SELECT data,status FROM scans ORDER BY rowid DESC LIMIT 1')
      .get() as { data: string; status: ScanProgress['status'] } | undefined
    return {
      ...counts,
      trash: (
        this.db.prepare("SELECT COUNT(*) n FROM files WHERE availability='trashed'").get() as {
          n: number
        }
      ).n,
      categoryCounts: Object.fromEntries(
        (
          this.db
            .prepare(
              "SELECT category,COUNT(*) n FROM files WHERE category IS NOT NULL AND availability NOT IN ('trashed','removed') GROUP BY category"
            )
            .all() as { category: Category; n: number }[]
        ).map(r => [r.category, r.n])
      ),
      lastScan: last ? { ...JSON.parse(last.data), status: last.status } : null,
    }
  }
  updateDecision(
    changes: { id: string; revision: number }[],
    field: 'category' | 'review',
    value: Category | null | 'review' | 'exclude'
  ) {
    const unique = new Set(changes.map(c => c.id))
    if (unique.size !== changes.length) throw new Error('Duplicate track selection.')
    this.db.transaction(() => {
      for (const change of changes) {
        const t = this.get(change.id)
        if (!t || ['trashed', 'removed'].includes(t.availability) || t.revision !== change.revision)
          throw new Error('The selection changed. Refresh it before saving. No changes were saved.')
        const nextReview =
          field === 'review'
            ? value === 'exclude'
              ? 'Excluded'
              : 'Needs Review'
            : value
              ? 'Ready for Approval'
              : 'Needs Manual Classification'
        if (field === 'category')
          this.db
            .prepare('UPDATE files SET category=?,manual=1,review=?,revision=revision+1 WHERE id=?')
            .run(value, nextReview, t.id)
        else
          this.db
            .prepare('UPDATE files SET review=?,manual=1,revision=revision+1 WHERE id=?')
            .run(nextReview, t.id)
        this.db
          .prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?,?)')
          .run(
            randomUUID(),
            t.id,
            field,
            String(t[field] ?? ''),
            String(field === 'review' ? nextReview : (value ?? '')),
            new Date().toISOString(),
            t.revision + 1
          )
        this.db
          .prepare('UPDATE classification_results SET acknowledgedHash=inputHash WHERE fileId=?')
          .run(t.id)
      }
    })()
  }
  removeFromLibrary(
    change: { id: string; revision: number },
    reason: string,
    locationState: 'original-kept' | 'unconfirmed'
  ): void {
    if (typeof reason !== 'string' || !['original-kept', 'unconfirmed'].includes(locationState))
      throw new Error('Invalid library removal evidence.')
    this.db.transaction(() => {
      const file = this.get(change.id)
      if (
        !file ||
        file.revision !== change.revision ||
        ['trashed', 'removed'].includes(file.availability)
      )
        throw new Error('The track changed. Refresh before removing it from the library.')
      this.db
        .prepare(
          'INSERT INTO library_removals(fileId,originalAvailability,removedAt,reason,locationState) VALUES(?,?,?,?,?)'
        )
        .run(
          file.id,
          file.availability,
          new Date().toISOString(),
          reason.trim().slice(0, 2000) || 'Removed from the active library.',
          locationState
        )
      this.db
        .prepare(
          'INSERT INTO library_removal_locations(fileId,sourceId,path,available) SELECT fileId,sourceId,path,available FROM locations WHERE fileId=?'
        )
        .run(file.id)
      this.db
        .prepare("UPDATE files SET availability='removed',revision=revision+1 WHERE id=?")
        .run(file.id)
      this.db.prepare('UPDATE locations SET available=0 WHERE fileId=?').run(file.id)
      this.db.prepare('DELETE FROM playlist_approvals WHERE fileId=?').run(file.id)
      this.db.prepare('DELETE FROM classification_queue WHERE fileId=?').run(file.id)
      this.db.prepare('DELETE FROM organization_queue WHERE fileId=?').run(file.id)
      this.db.prepare('DELETE FROM research_queue WHERE fileId=?').run(file.id)
    })()
  }
  restoreToLibrary(change: { id: string; revision: number }): void {
    this.db.transaction(() => {
      const file = this.get(change.id)
      const removal = this.db
        .prepare('SELECT originalAvailability FROM library_removals WHERE fileId=?')
        .get(change.id) as { originalAvailability: Availability } | undefined
      if (
        !file ||
        file.availability !== 'removed' ||
        file.revision !== change.revision ||
        !removal ||
        ['removed', 'trashed'].includes(removal.originalAvailability)
      )
        throw new Error('The removed entry changed. Refresh before restoring it to the library.')
      this.db
        .prepare('UPDATE files SET availability=?,revision=revision+1 WHERE id=?')
        .run(removal.originalAvailability, file.id)
      this.db
        .prepare(
          'UPDATE locations SET available=COALESCE((SELECT saved.available FROM library_removal_locations saved WHERE saved.fileId=locations.fileId AND saved.sourceId=locations.sourceId AND saved.path=locations.path),0) WHERE fileId=?'
        )
        .run(file.id)
      this.db.prepare('DELETE FROM library_removals WHERE fileId=?').run(file.id)
    })()
  }
  register(
    record: Omit<Track, 'category' | 'review' | 'manual' | 'revision' | 'sourceLabel'> & {
      physicalKey: string
      signature: string
    },
    scanId: string
  ): 'new' | 'changed' {
    let outcome: 'new' | 'changed' = 'new'
    const existing = this.resolvePhysical(record.physicalKey, record.path)
    this.db.transaction(() => {
      if (existing) {
        outcome = 'changed'
        record.id = existing.id
        if (['trashed', 'removed'].includes(existing.availability)) return
        this.db
          .prepare(
            "UPDATE files SET path=@path,filename=@filename,sourceId=@sourceId,review=CASE WHEN manual=1 AND signature!=@signature AND review!='Excluded' THEN 'File Changed' ELSE review END,signature=@signature,artist=@artist,title=@title,bpm=@bpm,year=@year,genre=@genre,duration=@duration,format=@format,bitrate=@bitrate,sampleRate=@sampleRate,key=@key,size=@size,availability=@availability,metadataError=@metadataError,updatedAt=@updatedAt,tags=@tags,revision=revision+1 WHERE id=@id"
          )
          .run({ ...record, tags: JSON.stringify(record.tags) })
      } else {
        this.db
          .prepare(
            'INSERT INTO files(id,physicalKey,path,filename,sourceId,signature,artist,title,bpm,year,genre,duration,format,bitrate,sampleRate,key,size,availability,addedAt,updatedAt,metadataError,tags) VALUES(@id,@physicalKey,@path,@filename,@sourceId,@signature,@artist,@title,@bpm,@year,@genre,@duration,@format,@bitrate,@sampleRate,@key,@size,@availability,@addedAt,@updatedAt,@metadataError,@tags)'
          )
          .run({ ...record, tags: JSON.stringify(record.tags) })
      }
      this.observe(record.id, record.sourceId, record.path, scanId)
      if (record.availability === 'available')
        this.db
          .prepare('INSERT INTO tag_evidence VALUES(?,?,?,?,?)')
          .run(
            randomUUID(),
            record.id,
            record.signature,
            JSON.stringify(record.tags),
            record.updatedAt
          )
    })()
    return outcome
  }
  observe(fileId: string, sourceId: string, filePath: string, scanId: string) {
    if (
      this.db
        .prepare("SELECT 1 FROM files WHERE id=? AND availability IN ('trashed','removed')")
        .get(fileId)
    )
      return
    this.db.transaction(() => {
      const displaced = this.db
        .prepare(
          "SELECT id FROM files WHERE path=? AND id!=? AND availability NOT IN ('trashed','removed') UNION SELECT f.id FROM locations l JOIN files f ON f.id=l.fileId WHERE l.path=? AND f.id!=? AND f.availability NOT IN ('trashed','removed')"
        )
        .all(filePath, fileId, filePath, fileId) as { id: string }[]
      // This exact path was freshly observed with another identity. Invalidate
      // its old owners even in an incremental pass or overlapping source root.
      this.db
        .prepare('UPDATE locations SET available=0 WHERE path=? AND fileId!=?')
        .run(filePath, fileId)
      this.db
        .prepare(
          'INSERT INTO locations(fileId,sourceId,path,seenScan,available) VALUES(?,?,?,?,1) ON CONFLICT(sourceId,path) DO UPDATE SET fileId=excluded.fileId,seenScan=excluded.seenScan,available=1'
        )
        .run(fileId, sourceId, filePath, scanId)
      for (const old of displaced) {
        const alternative = this.db
          .prepare(
            'SELECT path,sourceId FROM locations WHERE fileId=? AND available=1 ORDER BY path LIMIT 1'
          )
          .get(old.id) as { path: string; sourceId: string } | undefined
        if (!alternative)
          this.db
            .prepare(
              "UPDATE files SET availability='missing',revision=revision+1 WHERE id=? AND availability!='missing'"
            )
            .run(old.id)
        else
          this.db
            .prepare(
              'UPDATE files SET path=?,filename=?,sourceId=?,revision=revision+1 WHERE id=? AND path=?'
            )
            .run(
              alternative.path,
              path.basename(alternative.path),
              alternative.sourceId,
              old.id,
              filePath
            )
        this.db.prepare('DELETE FROM playlist_approvals WHERE fileId=?').run(old.id)
      }
      // A repeated hard-link discovery is a location, not an additional copy.
      this.db
        .prepare("UPDATE files SET availability='available' WHERE id=? AND availability='missing'")
        .run(fileId)
    })()
  }
  finishSource(sourceId: string, scanId: string, complete: boolean) {
    this.db.transaction(() => {
      if (complete) {
        this.db
          .prepare(
            'UPDATE locations SET available=0 WHERE sourceId=? AND (seenScan IS NULL OR seenScan!=?)'
          )
          .run(sourceId, scanId)
        this.db
          .prepare(
            "UPDATE files SET availability='missing',revision=revision+1 WHERE availability NOT IN ('missing','trashed','removed') AND NOT EXISTS(SELECT 1 FROM locations l WHERE l.fileId=files.id AND l.available=1)"
          )
          .run()
        // Prefer a currently observed location if the canonical path disappeared.
        const relocated = this.db
          .prepare(
            "SELECT id,(SELECT path FROM locations l WHERE l.fileId=files.id AND l.available=1 ORDER BY path LIMIT 1) AS path,(SELECT sourceId FROM locations l WHERE l.fileId=files.id AND l.available=1 ORDER BY path LIMIT 1) AS sourceId FROM files WHERE availability NOT IN ('trashed','removed') AND EXISTS(SELECT 1 FROM locations l WHERE l.fileId=files.id AND l.available=1) AND NOT EXISTS(SELECT 1 FROM locations l WHERE l.fileId=files.id AND l.path=files.path AND l.available=1)"
          )
          .all() as { id: string; path: string; sourceId: string }[]
        for (const r of relocated)
          this.db
            .prepare('UPDATE files SET path=?,filename=?,sourceId=? WHERE id=?')
            .run(r.path, path.basename(r.path), r.sourceId, r.id)
      }
      this.db
        .prepare('UPDATE sources SET lastScan=COALESCE(?,lastScan),status=? WHERE id=?')
        .run(complete ? new Date().toISOString() : null, complete ? 'ready' : 'partial', sourceId)
    })()
  }
  saveScan(p: ScanProgress) {
    this.db
      .prepare(
        'INSERT INTO scans(id,kind,status,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data'
      )
      .run(p.id, p.kind, p.status, JSON.stringify(p))
  }
  enqueue(scanId: string, sourceId: string, dir: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO scan_queue(scanId,sourceId,path) VALUES(?,?,?)')
      .run(scanId, sourceId, dir)
  }
  nextDirectory(scanId: string, sourceId: string) {
    return this.db
      .prepare(
        'SELECT path FROM scan_queue WHERE scanId=? AND sourceId=? AND done=0 ORDER BY rowid LIMIT 1'
      )
      .get(scanId, sourceId) as { path: string } | undefined
  }
  directoryDone(scanId: string, sourceId: string, dir: string) {
    this.db
      .prepare('UPDATE scan_queue SET done=1 WHERE scanId=? AND sourceId=? AND path=?')
      .run(scanId, sourceId, dir)
  }
}

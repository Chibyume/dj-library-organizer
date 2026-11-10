export const STAGE_SCHEMA = `
CREATE TABLE tracks(trackKey TEXT PRIMARY KEY,attrs TEXT NOT NULL,localPath TEXT,refKind TEXT NOT NULL,tempo TEXT NOT NULL,cues TEXT NOT NULL);
CREATE INDEX track_location ON tracks(localPath);
CREATE TABLE nodes(id TEXT PRIMARY KEY,parentId TEXT,name TEXT NOT NULL,type TEXT NOT NULL,keyType TEXT,entries INTEGER NOT NULL,depth INTEGER NOT NULL,ordinal INTEGER NOT NULL);
CREATE TABLE memberships(nodeId TEXT NOT NULL,ordinal INTEGER NOT NULL,ref TEXT NOT NULL,keyType TEXT NOT NULL,trackKey TEXT,PRIMARY KEY(nodeId,ordinal));
CREATE INDEX membership_track ON memberships(trackKey);
CREATE TABLE matches(trackKey TEXT PRIMARY KEY,status TEXT NOT NULL,reason TEXT NOT NULL,fileId TEXT,candidates TEXT NOT NULL,conflicts TEXT NOT NULL);
`
export const XML_LIMITS = {
  bytes: 256 * 1024 * 1024,
  tracks: 250000,
  nodes: 100000,
  memberships: 1000000,
  depth: 64,
  preparation: 10000,
  attribute: 16384,
  token: 65536,
}

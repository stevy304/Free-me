import { DatabaseSync } from 'node:sqlite';
import { Client } from 'pg';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mediaDatabaseLock } from '../prototypes/database.mjs';

const sourcePath = process.argv[2] || join(process.env.FREEME_DATA_DIR || join(homedir(), '.free-me-video'), 'videos.sqlite');
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the migrated PostgreSQL target.');
const source = new DatabaseSync(sourcePath, { readOnly: true });
const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  source.exec('BEGIN');
  const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
  const accounts = tables.has('accounts') ? source.prepare('SELECT id, email, password FROM accounts').iterate() : [];
  const videos = source.prepare('SELECT * FROM videos ORDER BY rowid').iterate();
  await client.connect();
  await client.query('BEGIN');
  const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [mediaDatabaseLock]);
  if (!lock.rows[0].locked) throw new Error('Stop the PostgreSQL video service before importing.');
  const target = await client.query('SELECT EXISTS (SELECT 1 FROM accounts UNION ALL SELECT 1 FROM videos) AS populated');
  if (target.rows[0].populated) throw new Error('Import requires empty PostgreSQL accounts and videos tables.');
  let accountCount = 0;
  let videoCount = 0;
  for (const { id, email, password } of accounts) {
    await client.query('INSERT INTO accounts (id, email, password) VALUES ($1, $2, $3)', [id, email, password]);
    accountCount++;
  }
  for (const video of videos) {
    await client.query(
      'INSERT INTO videos (id, status, metadata, duration_seconds, owner_id, visibility) VALUES ($1, $2, $3, $4, $5, $6)',
      [video.id, video.status, video.metadata ?? '{}', video.duration_seconds ?? null, video.owner_id ?? null, video.visibility ?? 'public'],
    );
    videoCount++;
  }
  await client.query('COMMIT');
  console.log(`Imported ${accountCount} accounts and ${videoCount} videos. Sign in again to create new sessions.`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Import failed:', error.code || error.message);
  process.exitCode = 1;
} finally {
  source.close();
  await client.end();
}

import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';

export const mediaDatabaseLock = 734509216;

export async function openDatabase(sqlitePath) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString && process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL is required in production.');
  }
  if (!connectionString) {
    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    `);
    const columns = new Set(db.prepare('PRAGMA table_info(videos)').all().map((column) => column.name));
    if (!columns.has('metadata')) db.exec("ALTER TABLE videos ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
    if (!columns.has('duration_seconds')) db.exec('ALTER TABLE videos ADD COLUMN duration_seconds REAL');
    if (!columns.has('owner_id')) db.exec('ALTER TABLE videos ADD COLUMN owner_id TEXT');
    if (!columns.has('visibility')) db.exec("ALTER TABLE videos ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'");
    db.exec('CREATE INDEX IF NOT EXISTS videos_status ON videos (status)');
    return { prepare: (sql) => db.prepare(sql), orderColumn: 'rowid', health: () => db.prepare('SELECT 1').get() };
  }

  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5000,
  });
  pool.on('error', (error) => console.error('Idle PostgreSQL connection failed:', error.code || error.name));
  let lease;
  try {
    lease = await pool.connect();
    const { rows } = await lease.query('SELECT pg_try_advisory_lock($1) AS locked', [mediaDatabaseLock]);
    if (!rows[0].locked) throw Object.assign(new Error('A Free Me media service or import is already using this database.'), { code: 'MEDIA_DB_IN_USE' });
    await pool.query('SELECT id, owner_id, visibility, sequence FROM videos LIMIT 0');
    await pool.query('SELECT id, email, password FROM accounts LIMIT 0');
    await pool.query('SELECT token, account_id, expires FROM sessions LIMIT 0');
  } catch (error) {
    lease?.release(true);
    await pool.end();
    if (error.code === 'MEDIA_DB_IN_USE') throw error;
    throw new Error('PostgreSQL startup check failed (' + (error.code || error.name) + '). Check connectivity and run npm run db:migrate.');
  }
  lease.on('error', () => {
    console.error('PostgreSQL media worker lock connection lost. Restart the service.');
    process.exit(1);
  });
  return {
    close: async () => { lease.release(true); await pool.end(); },
    orderColumn: 'sequence',
    health: () => pool.query('SELECT 1'),
    prepare(sql) {
      let index = 0;
      const query = sql.replace(/\?/g, () => '$' + ++index);
      return {
        get: async (...values) => (await pool.query(query, values)).rows[0],
        all: async (...values) => (await pool.query(query, values)).rows,
        run: async (...values) => ({ changes: (await pool.query(query, values)).rowCount }),
      };
    },
  };
}

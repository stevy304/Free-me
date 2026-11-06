#!/usr/bin/env node
/**
 * `npm run dev`: everything Free Me needs on one machine, in one terminal.
 *   1. reads .env (created from .env.example on the first run, with a random SESSION_SECRET);
 *   2. starts PostgreSQL and Redis if they are installed but stopped (installs them with apt on Ubuntu if missing);
 *   3. creates the database user and database from DATABASE_URL, applies migrations, seeds categories;
 *   4. runs the API (http://localhost:4000, rebuilt on change), the media worker and the web app (http://localhost:3000).
 * Ctrl+C stops all three. In GitHub Codespaces the web address is the forwarded https address.
 */
import { execSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const C = { api: '\x1b[36m', worker: '\x1b[35m', web: '\x1b[32m', dev: '\x1b[33m', err: '\x1b[31m', off: '\x1b[0m' };
const say = (msg) => console.log(`${C.dev}[dev]${C.off} ${msg}`);
const fail = (msg) => { console.error(`${C.err}[dev] ${msg}${C.off}`); process.exit(1); };
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const quiet = (cmd) => spawnSync('sh', ['-c', cmd], { stdio: 'ignore' }).status === 0;
const sudo = process.getuid?.() === 0 ? '' : 'sudo -n ';

// 1. Configuration.
if (!existsSync('node_modules')) { say('Installing packages (npm install)…'); run('npm install'); }
if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  const env = readFileSync('.env', 'utf8').replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${randomBytes(36).toString('base64url')}`);
  writeFileSync('.env', env);
  say('Created .env from .env.example (edit it for Google sign-in, SMTP and administrators).');
}
process.loadEnvFile('.env');
const env = process.env;
env.NODE_ENV ||= 'development';
env.API_INTERNAL_URL ||= `http://localhost:${env.PORT || 4000}`;
// Codespaces: the browser reaches the app at a forwarded https address; cookies, redirects and the
// request-origin check must use it. Plain http://localhost:3000 still works for requests made inside.
if (env.CODESPACE_NAME && env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN && /^http:\/\/localhost(:\d+)?$/.test(env.APP_URL || 'http://localhost:3000')) {
  env.APP_URL = `https://${env.CODESPACE_NAME}-3000.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;
  env.EXTRA_ORIGINS = [env.EXTRA_ORIGINS, 'http://localhost:3000'].filter(Boolean).join(',');
}

const db = new URL(env.DATABASE_URL || fail('DATABASE_URL is missing from .env'));
const redis = env.REDIS_URL ? new URL(env.REDIS_URL) : null;
const local = (h) => ['localhost', '127.0.0.1', '::1'].includes(h);
const open = (host, port) => new Promise((ok) => { const s = net.connect({ host, port }, () => { s.end(); ok(true); }); s.on('error', () => ok(false)); s.setTimeout(1500, () => { s.destroy(); ok(false); }); });
const waitFor = async (host, port, secs) => { for (let i = 0; i < secs * 2; i++) { if (await open(host, port)) return true; await new Promise((r) => setTimeout(r, 500)); } return false; };

// Nothing else may hold the API and web ports (e.g. an earlier `npm run dev:web`).
for (const [port, what] of [[Number(env.PORT || 4000), 'API'], [3000, 'web app']]) {
  if (await open('127.0.0.1', port)) fail(`Port ${port} (${what}) is already in use. Stop the other process (e.g. an earlier npm run dev:web), then try again.`);
}

// 2. PostgreSQL and Redis.
const dbPort = Number(db.port || 5432);
const redisPort = redis ? Number(redis.port || 6379) : 0;
if (local(db.hostname) && !(await open('127.0.0.1', dbPort)) || (redis && local(redis.hostname) && !(await open('127.0.0.1', redisPort)))) {
  if (!has('psql') || !has('redis-server') || !has('ffmpeg')) {
    if (!has('apt-get')) fail('Install PostgreSQL 16, Redis 7 and FFmpeg, start them, then run npm run dev again.');
    say('Installing PostgreSQL, Redis and FFmpeg (first run only)…');
    run('bash scripts/dev-setup.sh');
  }
}
if (local(db.hostname) && !(await open('127.0.0.1', dbPort))) {
  say('Starting PostgreSQL…');
  quiet(`${sudo}service postgresql start`) || quiet(`${sudo}pg_ctlcluster --skip-systemctl-redirect $(ls /etc/postgresql | sort -V | tail -1) main start`);
  if (!(await waitFor('127.0.0.1', dbPort, 20))) fail(`PostgreSQL is not answering on port ${dbPort}. Start it, then run npm run dev again.`);
}
if (redis && local(redis.hostname) && !(await open('127.0.0.1', redisPort))) {
  say('Starting Redis…');
  quiet(`${sudo}service redis-server start`) || quiet(`redis-server --port ${redisPort} --daemonize yes --save "" --appendonly no`);
  if (!(await waitFor('127.0.0.1', redisPort, 10))) fail(`Redis is not answering on port ${redisPort}.`);
}
if (!has('ffmpeg')) say(`${C.err}FFmpeg is not installed: uploads will not be processed. Run: bash scripts/dev-setup.sh${C.off}`);

// 3. Database user, database, migrations and categories.
if (local(db.hostname) && has('psql')) {
  const user = decodeURIComponent(db.username), pass = decodeURIComponent(db.password), name = db.pathname.slice(1);
  const ok = spawnSync('psql', [env.DATABASE_URL, '-tAc', 'select 1'], { stdio: 'ignore' }).status === 0;
  if (!ok) {
    say(`Creating database user "${user}" and database "${name}"…`);
    const q = (v) => v.replace(/'/g, "''");
    const sql = `DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${q(user)}') THEN CREATE ROLE "${user}" LOGIN CREATEDB PASSWORD '${q(pass)}';
      ELSE ALTER ROLE "${user}" LOGIN CREATEDB PASSWORD '${q(pass)}'; END IF; END $$;
      SELECT 'CREATE DATABASE "${name}" OWNER "${user}"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${q(name)}')\\gexec
`;
    // Run psql as the postgres system user (peer authentication), with the SQL on standard input.
    // `sudo su postgres` rather than `sudo -u postgres`: Codespaces and many servers allow password-free sudo only as root.
    // -n: never stop to ask for a password.
    const asPostgres = sudo ? ['sudo', ['-n', 'su', 'postgres', '-c', 'psql -q -v ON_ERROR_STOP=1']] : ['su', ['postgres', '-c', 'psql -q -v ON_ERROR_STOP=1']];
    const r = spawnSync(asPostgres[0], asPostgres[1], { input: sql, stdio: ['pipe', 'inherit', 'inherit'] });
    if (r.status !== 0) fail(`Could not create the database user. Create it yourself, then run npm run dev again:\n  sudo su postgres -c "psql -c \\"CREATE ROLE ${user} LOGIN CREATEDB PASSWORD '${pass}'\\""\n  sudo su postgres -c "createdb -O ${user} ${name}"`);
  }
}
// The database client must match the schema of the code being run: after a git pull it is out of date (npm install
// only regenerates it when packages change), and the API then answers 500 ("Unknown field …").
say('Preparing the database client…');
run('npx prisma generate', { stdio: ['ignore', 'ignore', 'inherit'] });
say('Applying database migrations…');
run('npx prisma migrate deploy', { stdio: ['ignore', 'ignore', 'inherit'] });
run('npm run -s db:seed');

// 4. The three processes.
say('Building the shared package and the API…');
run('npm run -s build -w @free-me/shared');
run('npx swc src -d dist --strip-leading-paths --copy-files -q', { cwd: 'apps/api' });

/** A package's command, from the workspace's own node_modules first (npm may install it there), then the root. */
const bin = (name, ws) => [join(root, ws, 'node_modules', '.bin', name), join(root, 'node_modules', '.bin', name)].find(existsSync) ?? fail(`${name} is not installed: run npm install.`);
const children = [];
function start(name, cmd, args, cwd) {
  // Own process group, so stopping it also stops what it started (Next.js runs its server as a child).
  const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const tag = `${C[name] ?? ''}[${name}]${C.off} `;
  const pipe = (stream, out) => { let buf = ''; stream.on('data', (d) => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); for (const l of lines) out.write(tag + l + '\n'); }); };
  pipe(p.stdout, process.stdout); pipe(p.stderr, process.stderr);
  p.on('error', (e) => { console.error(`${tag}could not start: ${e.message}`); stop(1); });
  p.on('exit', (code) => { if (!stopping) { console.error(`${tag}stopped (exit ${code}); stopping everything.`); stop(1); } });
  children.push(p);
}
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  const signal = (sig) => { for (const p of children) { try { process.kill(-p.pid, sig); } catch { /* already gone */ } } };
  signal('SIGTERM');
  setTimeout(() => { signal('SIGKILL'); process.exit(code); }, 3000);
}
process.on('exit', () => { for (const p of children) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } } });
process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0));

start('swc', bin('swc', 'apps/api'), [ 'src', '-d', 'dist', '--strip-leading-paths', '--copy-files', '-w', '-q'], 'apps/api');
start('api', process.execPath, ['--watch', 'dist/main.js'], 'apps/api');
start('worker', process.execPath, ['--watch', 'dist/worker.js'], 'apps/api');
start('web', bin('next', 'apps/web'), ['dev', '-p', '3000'], 'apps/web');

await waitFor('127.0.0.1', 3000, 60);
say(`Free Me is running: ${C.web}${env.APP_URL}${C.off}  (API ${env.API_INTERNAL_URL}/api, docs ${env.API_INTERNAL_URL}/api/docs)`);
if (env.MAIL_TRANSPORT === 'console') say('Sign-in codes are printed in the [api] lines below.');
say('Press Ctrl+C to stop everything.');

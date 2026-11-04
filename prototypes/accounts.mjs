import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { boundedBody } from './request-body.mjs';

const derive = promisify(scrypt);
const lifetime = 7 * 86400;
const cookieName = 'freeme_session';
const digest = (token) => createHash('sha256').update(token).digest('hex');
const tokenFrom = (request) => request.headers.cookie?.match(/(?:^|;\s*)freeme_session=([a-f0-9]{64})(?:;|$)/)?.[1];

export async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw Object.assign(new Error('Send application/json'), { status: 415 });
  }
  if (Number(request.headers['content-length']) > 8192) {
    throw Object.assign(new Error('JSON body exceeds 8 KiB'), { status: 413 });
  }
  const chunks = [];
  for await (const chunk of boundedBody(request, 8192, 'JSON body exceeds 8 KiB')) chunks.push(chunk);
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

export function createAccounts(db, json) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL);
  `);
  const user = db.prepare('SELECT id, email, password FROM accounts WHERE email = ?');
  const insert = db.prepare('INSERT OR IGNORE INTO accounts VALUES (?, ?, ?)');
  const session = db.prepare('SELECT accounts.id, accounts.email FROM sessions JOIN accounts ON accounts.id = sessions.account_id WHERE token = ? AND expires > ?');
  const createSession = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  const revoke = db.prepare('DELETE FROM sessions WHERE token = ?');
  const purge = db.prepare('DELETE FROM sessions WHERE expires <= ?');
  let windowEnd = 0;
  let attempts = 0;
  let active = 0;

  function viewer(request) {
    const token = tokenFrom(request);
    return token ? session.get(digest(token), Date.now()) : undefined;
  }

  function cookie(request, token, age) {
    const secure = request.socket.encrypted || process.env.FREEME_SECURE_COOKIES === '1' || request.headers['x-forwarded-proto'] === 'https';
    return cookieName + '=' + token + '; Path=/api; HttpOnly; SameSite=Lax; Max-Age=' + age + (secure ? '; Secure' : '');
  }

  async function handle(request, response, path) {
    if (request.method === 'GET' && path === '/account/session') return json(response, 200, { account: viewer(request) ?? null });
    if (request.method !== 'POST' || !['/account/register', '/account/login', '/account/logout'].includes(path)) {
      return json(response, 404, { error: 'Not found' });
    }
    const body = await readJson(request);
    if (path === '/account/logout') {
      const token = tokenFrom(request);
      if (token) revoke.run(digest(token));
      response.setHeader('Set-Cookie', cookie(request, '', 0));
      return json(response, 200, { account: null });
    }

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = body.password;
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        typeof password !== 'string' || password.length < 12 || password.length > 128) {
      return json(response, 400, { error: 'Enter a valid email and a password of 12–128 characters.' });
    }
    const now = Date.now();
    if (now >= windowEnd) { windowEnd = now + 60_000; attempts = 0; }
    if (attempts >= 30 || active >= 2) return json(response, 429, { error: 'Too many attempts. Try again shortly.' });
    attempts++;
    active++;
    try {
      const existing = user.get(email);
      const register = path === '/account/register';
      const salt = register ? randomBytes(16).toString('hex') : existing?.password.split(':')[0] || '0'.repeat(32);
      const key = await derive(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
      const id = register ? randomBytes(16).toString('hex') : existing?.id;
      if (register) {
        if (!insert.run(id, email, salt + ':' + key.toString('hex')).changes) return json(response, 409, { error: 'Could not register this email.' });
      } else if (!existing || !timingSafeEqual(key, Buffer.from(existing.password.split(':')[1], 'hex'))) {
        return json(response, 401, { error: 'Invalid email or password.' });
      }
      const previous = tokenFrom(request);
      if (previous) revoke.run(digest(previous));
      const token = randomBytes(32).toString('hex');
      purge.run(now);
      createSession.run(digest(token), id, now + lifetime * 1000);
      response.setHeader('Set-Cookie', cookie(request, token, lifetime));
      return json(response, register ? 201 : 200, { account: { id, email } });
    } finally {
      active--;
    }
  }
  return { viewer, handle };
}

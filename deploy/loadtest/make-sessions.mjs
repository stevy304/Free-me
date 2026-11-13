#!/usr/bin/env node
// Test accounts with live sessions for player-bench.mjs, written straight to a TEST database (never production).
//   node deploy/loadtest/make-sessions.mjs 2000 > /tmp/sessions.sql && psql "$DATABASE_URL" -f /tmp/sessions.sql
// It writes the session tokens to sessions.txt (or SESSIONS) and the SQL to stdout.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const n = Math.max(1, Number(process.argv[2] ?? 1000));
const tokens = [];
const sql = ['BEGIN;'];
for (let i = 0; i < n; i++) {
  const user = randomUUID();
  const token = randomBytes(32).toString('base64url');
  tokens.push(token);
  const hash = createHash('sha256').update(token).digest('hex');
  sql.push(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('${user}', 'bench-${user}@example.com', now());`);
  sql.push(`INSERT INTO "Session" ("id", "tokenHash", "userId", "method", "expiresAt") VALUES ('${randomUUID()}', '${hash}', '${user}', 'email_otp', now() + interval '1 day');`);
}
sql.push('COMMIT;');
writeFileSync(process.env.SESSIONS ?? 'sessions.txt', tokens.join('\n'));
console.log(sql.join('\n'));

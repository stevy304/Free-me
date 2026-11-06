import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

/**
 * Imports a list of fingerprints of content that must not be published (e.g. from an industry hash-sharing programme
 * you are a member of). One hex hash per line: 32 characters = MD5, 64 = SHA-256; blank lines and # comments skipped.
 *   node dist/tools/import-hashes.js <file> "<list name>"
 * Matching uploads are held for a moderator, never published automatically.
 */
async function main() {
  const [file, name] = process.argv.slice(2);
  if (!file || !name) { console.error('Usage: import-hashes <file> "<list name>"'); process.exit(1); }
  const prisma = new PrismaClient();
  let added = 0; let skipped = 0; let bad = 0;
  const rows: Array<{ algorithm: 'MD5' | 'SHA256'; value: string; source: 'LIST'; note: string }> = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith('#')) continue;
    if (/^[0-9a-f]{32}$/.test(line)) rows.push({ algorithm: 'MD5', value: line, source: 'LIST', note: name });
    else if (/^[0-9a-f]{64}$/.test(line)) rows.push({ algorithm: 'SHA256', value: line, source: 'LIST', note: name });
    else bad++;
  }
  for (let i = 0; i < rows.length; i += 5000) {
    const r = await prisma.blockedHash.createMany({ data: rows.slice(i, i + 5000), skipDuplicates: true });
    added += r.count; skipped += Math.min(5000, rows.length - i) - r.count;
  }
  console.log(JSON.stringify({ list: name, added, alreadyKnown: skipped, unreadableLines: bad }));
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });

import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { ConfigError, loadConfig } from '../config/config';
import { MediaJobs, VideoBusy } from '../media/jobs';
import { createStorage } from '../media/storage';

/**
 * Checks every ready video's files and, with --apply, brings back files left in the wrong storage place.
 *   node dist/tools/repair-media.js            report only (changes nothing)
 *   node dist/tools/repair-media.js --apply    repair
 * Safe to run while the site is up: each video is locked like a media job while it is repaired.
 */
async function main() {
  const apply = process.argv.includes('--apply');
  let config;
  try { config = loadConfig(); } catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(1); } throw e; }
  const prisma = new PrismaClient();
  const redis = config.redisUrl ? new Redis(config.redisUrl) : null;
  const jobs = new MediaJobs(prisma, createStorage(config), config, redis);
  const totals = { checked: 0, fine: 0, needsRepair: 0, repaired: 0, busy: 0, stillMissing: 0 };
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.video.findMany({ where: { hlsMasterKey: { not: null } }, select: { id: true }, orderBy: { id: 'asc' }, take: 200, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (!batch.length) break;
    for (const { id } of batch) {
      totals.checked++;
      try {
        const r = await jobs.repair(id, apply);
        if (!r) continue;
        if (!r.leftovers && !r.missing.length) { totals.fine++; continue; }
        totals.needsRepair++;
        if (apply && r.leftovers) totals.repaired++;
        const after = apply ? await jobs.repair(id, false) : null;
        if (after?.missing.length || (!apply && r.missing.length && !r.toCopy)) totals.stillMissing++;
        console.log(JSON.stringify({ ...r, ...(after ? { missingAfter: after.missing } : {}) }));
      } catch (e) {
        if (e instanceof VideoBusy) { totals.busy++; console.log(JSON.stringify({ videoId: id, busy: true })); continue; }
        throw e;
      }
    }
    cursor = batch.at(-1)!.id;
  }
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'report', ...totals }));
  if (!apply && totals.needsRepair) console.log('Run again with --apply to repair. Busy videos can be retried later.');
  await prisma.$disconnect();
  await redis?.quit();
}

main().catch((e) => { console.error(e); process.exit(1); });

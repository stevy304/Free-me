import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { Logger } from '@nestjs/common';
import { ConfigError, loadConfig } from './config/config';
import { createApp } from './bootstrap';

/**
 * API_PROCESSES: how many API processes share the port (Node's cluster module). One Node process uses one CPU core,
 * so on a 4-core server `auto` (one per core) answers about four times as many requests. Everything shared lives in
 * PostgreSQL and Redis, and live updates use WebSockets only (no sticky sessions needed). Default 1.
 */
function processes(): number {
  const raw = process.env.API_PROCESSES?.trim();
  if (!raw) return 1;
  if (raw === 'auto') return availableParallelism();
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : 1;
}

async function serve() {
  let config;
  try { config = loadConfig(); } catch (e) {
    if (e instanceof ConfigError) { console.error(e.message); process.exit(1); }
    throw e;
  }
  const app = await createApp(config);
  await app.listen(config.port, '0.0.0.0');
  if (cluster.isPrimary) new Logger('Free Me').log(`API listening on :${config.port} (${config.nodeEnv}); web origin ${config.appUrl}`);
}

const count = processes();
if (cluster.isPrimary && count > 1) {
  try { loadConfig(); } catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(1); } throw e; }
  const log = new Logger('Free Me');
  log.log(`Starting ${count} API processes`);
  for (let i = 0; i < count; i++) cluster.fork();
  let stopping = false;
  // A process that crashes is replaced (after a short pause, so a broken release does not spin).
  cluster.on('exit', (worker, code) => { if (stopping) return; log.warn(`API process ${worker.process.pid} exited (${code}); starting another`); setTimeout(() => cluster.fork(), 1000); });
  const stop = () => { stopping = true; for (const w of Object.values(cluster.workers ?? {})) w?.process.kill('SIGTERM'); setTimeout(() => process.exit(0), 15_000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  cluster.on('exit', () => { if (stopping && !Object.keys(cluster.workers ?? {}).length) process.exit(0); });
} else {
  serve().catch((e) => { console.error(e); process.exit(1); });
}

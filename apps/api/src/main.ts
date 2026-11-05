import { Logger } from '@nestjs/common';
import { ConfigError, loadConfig } from './config/config';
import { createApp } from './bootstrap';

async function main() {
  let config;
  try { config = loadConfig(); } catch (e) {
    if (e instanceof ConfigError) { console.error(e.message); process.exit(1); }
    throw e;
  }
  const app = await createApp(config);
  await app.listen(config.port, '0.0.0.0');
  new Logger('Free Me').log(`API listening on :${config.port} (${config.nodeEnv}); web origin ${config.appUrl}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

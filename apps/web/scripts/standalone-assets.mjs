// The standalone server (output: 'standalone') does not include static assets; copy them next to it.
import { cpSync, existsSync } from 'node:fs';

const target = '.next/standalone/apps/web';
if (existsSync(target)) {
  cpSync('.next/static', `${target}/.next/static`, { recursive: true });
  cpSync('public', `${target}/public`, { recursive: true });
}

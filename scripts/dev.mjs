import { spawn, spawnSync } from 'node:child_process';

const remoteOrigin = process.env.FREEME_VIDEO_ORIGIN;
if (!remoteOrigin && ['ffmpeg', 'ffprobe'].some((binary) =>
  spawnSync(binary, ['-version'], { stdio: 'ignore' }).status !== 0
)) {
  console.error('Free Me requires FFmpeg and ffprobe. In Codespaces, run: sudo apt-get update && sudo apt-get install -y ffmpeg');
  process.exit(1);
}

const port = process.env.PORT || '4400';
const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill();
}

function start(label, args, env = process.env) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env });
  children.push(child);
  child.once('error', (error) => {
    console.error(label + ': ' + error.message);
    stop(1);
  });
  child.once('exit', (code) => {
    if (!stopping) console.error(label + ' stopped.');
    stop(code ?? 1);
  });
}

process.once('SIGINT', () => stop(130));
process.once('SIGTERM', () => stop(143));
if (!remoteOrigin) start('Video backend', ['prototypes/video-backend.mjs']);
start('Web app', ['node_modules/vite/bin/vite.js', '--port=3000', '--host=0.0.0.0', ...process.argv.slice(2)], {
  ...process.env,
  FREEME_VIDEO_ORIGIN: remoteOrigin || 'http://127.0.0.1:' + port,
});

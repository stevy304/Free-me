import { run } from '../src/media/probe';

test('an already canceled encoding does not start a child', async () => {
  const reason = new Error('lease lost');
  await expect(run('/nonexistent-encoder', [], undefined, AbortSignal.abort(reason))).rejects.toBe(reason);
});

test('cancellation waits for child shutdown before rejecting with the original reason', async () => {
  const abort = new AbortController();
  const reason = new Error('lease lost');
  let pid = 0;
  const execution = run(process.execPath, ['-e', `
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));
    setInterval(() => {}, 1000);
    console.log(process.pid);
  `], (output) => { pid = Number(output.trim()); abort.abort(reason); }, abort.signal);
  await expect(execution).rejects.toBe(reason);
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
});

test('an encoder ignoring graceful cancellation is forcibly stopped', async () => {
  const abort = new AbortController();
  const reason = new Error('shutdown');
  let pid = 0;
  const execution = run(process.execPath, ['-e', `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    console.log(process.pid);
  `], (output) => { pid = Number(output.trim()); abort.abort(reason); }, abort.signal);
  await expect(execution).rejects.toBe(reason);
  expect(() => process.kill(pid, 0)).toThrow();
});

test('normal output and spawn failures still reach the caller', async () => {
  await expect(run(process.execPath, ['-e', 'console.log("ready")'])).resolves.toMatchObject({ stdout: 'ready\n' });
  await expect(run('/nonexistent-encoder', [])).rejects.toMatchObject({ code: 'ENOENT' });
});

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of children) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 700);
}
for (const args of [
  ['server/api.mjs'],
  [
    'node_modules/vinext/dist/cli.js',
    'dev',
    '--hostname',
    '127.0.0.1',
    '--port',
    '3000',
  ],
]) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  children.push(child);
  child.on('exit', (code) => {
    if (!stopping) stop(code || 0);
  });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

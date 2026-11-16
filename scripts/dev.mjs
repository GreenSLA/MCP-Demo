import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { localPostgres } from './local-postgres.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const children = [];
const database = await localPostgres(root);
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolve();
          const timeout = setTimeout(resolve, 3000);
          child.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
          child.kill('SIGTERM');
        }),
    ),
  );
  try {
    await database?.stop();
  } finally {
    process.exit(code);
  }
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

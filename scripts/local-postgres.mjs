import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );
const execute = promisify(execFile);
function clusterDirectory(root) {
  const instance = createHash('sha256')
    .update(resolve(root))
    .digest('hex')
    .slice(0, 12);
  return join(
    process.env.LOCALAPPDATA || homedir(),
    'itis-navigator',
    instance,
  );
}
const pgPort = () => Number(process.env.ITIS_POSTGRES_PORT || 55432);
const connection = (password, port) =>
  'postgresql://itis:' + password + '@127.0.0.1:' + port + '/postgres';
export async function localDatabaseUrl(root) {
  return (
    process.env.DATABASE_URL ||
    connection(
      (
        await readFile(
          join(clusterDirectory(root), 'postgres-password'),
          'utf8',
        )
      ).trim(),
      pgPort(),
    )
  );
}

async function windowsCluster(base, databaseDir, secret, port) {
  // initdb on Windows cannot re-execute from a non-ASCII directory.
  const { initdb } = await import('@embedded-postgres/windows-x64');
  const native = join(base, 'postgres-bin');
  const bin = join(native, 'bin');
  if (!(await exists(join(bin, 'postgres.exe'))))
    await cp(dirname(dirname(initdb)), native, { recursive: true });
  const run = (name, args) =>
    execute(join(bin, name + '.exe'), args, {
      windowsHide: true,
      timeout: 30000,
    });
  if (!(await exists(join(databaseDir, 'PG_VERSION'))))
    await run('initdb', [
      '-D',
      databaseDir,
      '--username=itis',
      '--auth=scram-sha-256',
      '--pwfile=' + secret,
      '--encoding=UTF8',
      '--locale=C',
    ]);
  await run('pg_ctl', [
    'start',
    '-w',
    '-D',
    databaseDir,
    '-l',
    join(base, 'postgres.log'),
    '-o',
    '-h 127.0.0.1 -p ' + port,
  ]);
  return {
    stop: () => run('pg_ctl', ['stop', '-w', '-m', 'fast', '-D', databaseDir]),
  };
}

export async function localPostgres(root) {
  if (process.env.DATABASE_URL) return;
  const base = clusterDirectory(root);
  await mkdir(base, { recursive: true });
  const secret = join(base, 'postgres-password');
  let password;
  try {
    password = (await readFile(secret, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const fresh = randomBytes(24).toString('hex');
    await writeFile(secret, fresh, { mode: 0o600, flag: 'wx' }).catch((e) => {
      if (e.code !== 'EEXIST') throw e;
    });
    password = (await readFile(secret, 'utf8')).trim();
  }
  const port = pgPort();
  const databaseDir = join(base, 'postgres');
  let cluster;
  if (process.platform === 'win32')
    cluster = await windowsCluster(base, databaseDir, secret, port);
  else {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    cluster = new EmbeddedPostgres({
      databaseDir,
      user: 'itis',
      password,
      port,
      persistent: true,
      postgresFlags: ['-h', '127.0.0.1'],
      initdbFlags: ['--encoding=UTF8', '--locale=C'],
      autoRehydrateSymlinks: true,
      onLog: () => {},
    });
    if (!(await exists(join(databaseDir, 'PG_VERSION'))))
      await cluster.initialise();
    await cluster.start();
  }
  process.env.DATABASE_URL = connection(password, port);
  return cluster;
}

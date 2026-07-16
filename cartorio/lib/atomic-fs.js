import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export async function writeFileAtomic(filePath, data, { mode = 0o600 } = {}) {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = makeTmpPath(filePath);

  const handle = await open(tmpPath, fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY, mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tmpPath, filePath);
  await fsyncPath(dir);
  return filePath;
}

export async function appendFileAtomic(filePath, data, { mode = 0o600 } = {}) {
  let previous = '';
  try {
    previous = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  return writeFileAtomic(filePath, `${previous}${data}`, { mode });
}

export async function fsyncPath(path) {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function recoverAtomicOrphans(dir, { prefix = '' } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const entries = await readdir(dir);
  const recovered = [];
  for (const entry of entries) {
    if (!entry.includes('.tmp-')) {
      continue;
    }
    if (prefix && !entry.startsWith(prefix)) {
      continue;
    }
    const orphan = join(dir, entry);
    await rm(orphan, { force: true });
    recovered.push(orphan);
  }
  if (recovered.length > 0) {
    await fsyncPath(dir);
  }
  return recovered;
}

function makeTmpPath(filePath) {
  return join(dirname(filePath), `${basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

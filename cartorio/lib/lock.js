import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function withLock(lockPath, fn, options = {}) {
  const lockHandle = await acquireLock(lockPath, options);
  try {
    return await fn(lockHandle);
  } finally {
    await releaseLock(lockHandle);
  }
}

export async function acquireLock(lockPath, { timeoutMs = 5000, pollMs = 20 } = {}) {
  const started = Date.now();
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(join(lockPath, 'owner.json'), `${JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString()
      })}\n`, { mode: 0o600 });
      return { lockPath };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() - started >= timeoutMs) {
        throw Object.assign(
          new Error(`timeout acquiring lock: ${lockPath}`),
          { code: 'LOCK_TIMEOUT', lockPath }
        );
      }
      await sleep(pollMs);
    }
  }
}

export async function releaseLock(lockHandle) {
  if (!lockHandle?.lockPath) {
    return;
  }
  await rm(lockHandle.lockPath, { recursive: true, force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

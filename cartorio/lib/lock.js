export async function withLock(lockPath, fn) {
  throw new Error(`lock.withLock not_implemented: ${lockPath} ${typeof fn}`);
}

export async function acquireLock(lockPath) {
  throw new Error(`lock.acquireLock not_implemented: ${lockPath}`);
}

export async function releaseLock(lockHandle) {
  throw new Error(`lock.releaseLock not_implemented: ${String(lockHandle)}`);
}

import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { publicError } from "./sanitize.mjs";

const OPENCLAW_ROOT = "/Users/openclaw/.openclaw";
const MAX_FILE_BYTES = 1024 * 1024;
const OWNER_UID = typeof process.getuid === "function" ? process.getuid() : null;
const O_NOFOLLOW = constants.O_NOFOLLOW || 0;

export class SourceReadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SourceReadError";
    this.code = code;
  }
}

export function sourceError(source, err) {
  const code = err && typeof err.code === "string" ? err.code : "SOURCE_ERROR";
  const known = err instanceof SourceReadError || ["ENOENT", "EACCES", "EPERM"].includes(code);
  return publicError(source, known ? code : "SOURCE_ERROR", known ? "fonte indisponivel" : "erro de leitura da fonte");
}

export function ensureAllowed(candidate) {
  const resolved = path.resolve(candidate);
  if (resolved !== OPENCLAW_ROOT && !resolved.startsWith(`${OPENCLAW_ROOT}/`)) {
    throw new SourceReadError("OUTSIDE_ALLOWLIST", "outside allowlist");
  }
  return resolved;
}

export async function safeReadText(filePath, { maxBytes = MAX_FILE_BYTES } = {}) {
  const resolved = ensureAllowed(filePath);
  let handle;
  try {
    const lst = await fs.lstat(resolved);
    if (lst.isSymbolicLink()) throw new SourceReadError("SYMLINK_REJECTED", "symlink rejected");
    handle = await fs.open(resolved, constants.O_RDONLY | O_NOFOLLOW);
    const st = await handle.stat();
    if (!st.isFile()) throw new SourceReadError("NOT_FILE", "not a regular file");
    if (OWNER_UID !== null && st.uid !== OWNER_UID) throw new SourceReadError("OWNER_REJECTED", "unexpected owner");
    if (st.size > maxBytes) throw new SourceReadError("FILE_TOO_LARGE", "file too large");
    const buffer = Buffer.alloc(st.size);
    const { bytesRead } = await handle.read(buffer, 0, st.size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export async function safeJson(filePath, options = {}) {
  const text = await safeReadText(filePath, options);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SourceReadError("JSON_INVALID", "invalid json");
  }
}

export async function safeExistsFile(filePath) {
  const resolved = ensureAllowed(filePath);
  let handle;
  try {
    const lst = await fs.lstat(resolved);
    if (lst.isSymbolicLink()) return false;
    handle = await fs.open(resolved, constants.O_RDONLY | O_NOFOLLOW);
    const st = await handle.stat();
    if (!st.isFile()) return false;
    if (OWNER_UID !== null && st.uid !== OWNER_UID) return false;
    return true;
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export function withTimeout(promise, ms, code = "SOURCE_TIMEOUT") {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SourceReadError(code, "source timeout")), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

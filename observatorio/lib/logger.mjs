import { promises as fs } from "node:fs";
import path from "node:path";
import { sanitize } from "./sanitize.mjs";

const LOG_DIR = "/Users/openclaw/.openclaw/workspace-neo/orchestration-dashboard/logs";
const LOG_FILE = path.join(LOG_DIR, "dashboard.log");
const MAX_BYTES = 128 * 1024;
const RETAIN = 3;

async function rotateIfNeeded() {
  await fs.mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
  let st;
  try {
    st = await fs.stat(LOG_FILE);
  } catch {
    return;
  }
  if (st.size < MAX_BYTES) return;
  for (let i = RETAIN - 1; i >= 1; i -= 1) {
    const src = `${LOG_FILE}.${i}`;
    const dst = `${LOG_FILE}.${i + 1}`;
    try {
      await fs.rename(src, dst);
    } catch {}
  }
  try {
    await fs.rename(LOG_FILE, `${LOG_FILE}.1`);
  } catch {}
}

export async function log(level, message, meta = {}) {
  const entry = sanitize({
    ts: new Date().toISOString(),
    level,
    message,
    meta
  });
  await rotateIfNeeded();
  await fs.appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

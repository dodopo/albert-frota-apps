#!/usr/bin/env node
import { buildUidPeerHelper } from '../lib/uid-peer.js';

async function main() {
  const result = await buildUidPeerHelper({ force: true });
  console.log(JSON.stringify(result));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error.code ?? error.name ?? 'ERROR',
    message: error.message,
    details: error.details ?? null
  }));
  process.exitCode = 1;
});

#!/bin/sh
set -eu

ledger_path="${CARTORIO_LEDGER_PATH:-/Users/cartorio/ledger/missoes.jsonl}"

if [ ! -f "$ledger_path" ]; then
  exit 0
fi

node --input-type=module - "$ledger_path" <<'NODE'
import { readFileSync } from 'node:fs';

const ledgerPath = process.argv[2];
const states = new Map();
const text = readFileSync(ledgerPath, 'utf8');
for (const line of text.split('\n')) {
  if (!line) {
    continue;
  }
  const record = JSON.parse(line);
  if (typeof record.missaoId === 'string' && typeof record.stateAfter === 'string') {
    states.set(record.missaoId, record.stateAfter);
  }
}

const open = [...states.entries()]
  .filter(([, state]) => state !== 'verificada')
  .map(([missaoId, state]) => `${missaoId}:${state}`);

if (open.length > 0) {
  console.error(`missao pre-commit: missão aberta detectada (${open.join(', ')})`);
  console.error('Finalize com missao entregar/coletar ou use o required check remoto como defesa dura.');
  process.exit(1);
}
NODE

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildReceipt, RECEIPT_VERSION } from '../lib/receipt.js';
import { makeEnvelope, protocolVersion, SUPPORTED_COMMANDS } from '../lib/protocol.js';

const execFileAsync = promisify(execFile);

test('missao exposes help and version', async () => {
  const help = await execFileAsync(process.execPath, ['bin/missao.js', '--help']);
  assert.match(help.stdout, /Uso:/);
  assert.match(help.stdout, /abrir/);

  const version = await execFileAsync(process.execPath, ['bin/missao.js', '--version']);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('ledgerd exposes help, version, and smoke check', async () => {
  const help = await execFileAsync(process.execPath, ['bin/ledgerd.js', '--help']);
  assert.match(help.stdout, /Daemon escritor unico minimo/);

  const version = await execFileAsync(process.execPath, ['bin/ledgerd.js', '--version']);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

  const smoke = await execFileAsync(process.execPath, ['bin/ledgerd.js', '--self-check']);
  assert.match(smoke.stdout.trim(), /^ledgerd self-check ok codeManifestHash=[0-9a-f]{64}$/);
});

test('protocol envelope and receipt skeleton keep required fields visible', () => {
  const envelope = makeEnvelope({
    command: SUPPORTED_COMMANDS[0],
    idempotencyKey: 'missao:test:abrir:1',
    actorUid: 501,
    runId: 'agent:neo:subagent:000000000000'
  });

  assert.equal(envelope.protocol, protocolVersion);

  const receipt = buildReceipt({
    missaoId: 'f1-test',
    eventId: '00000000-0000-4000-8000-000000000000',
    ledgerHeadHash: 'a'.repeat(64),
    ledgerSeq: 1,
    parentCommit: 'b'.repeat(40),
    treeScope: 'cartorio.git-tree.v1:app-files-excluding-mission-receipts',
    treeHashExcludingReceipts: 'c'.repeat(64),
    artefatos: [{ path: 'package.json', blobSha256: 'd'.repeat(64) }],
    runId: envelope.runId,
    ator: 'openclaw',
    actorUid: 501,
    ts: '2026-07-16T00:00:00.000Z',
    keyId: '1'.repeat(16),
    codeManifestHash: 'e'.repeat(64)
  });

  assert.equal(receipt.version, RECEIPT_VERSION);
  assert.ok(Object.hasOwn(receipt, 'signature'));
});

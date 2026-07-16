import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeEnvelope } from '../lib/protocol.js';

const execFileAsync = promisify(execFile);

const help = await execFileAsync(process.execPath, ['bin/missao.js', '--help']);
assert.match(help.stdout, /missao 0\.2\.0/);
assert.match(help.stdout, /Comandos:/);

const version = await execFileAsync(process.execPath, ['bin/missao.js', '--version']);
assert.equal(version.stdout.trim(), '0.2.0');

const ledgerdHelp = await execFileAsync(process.execPath, ['bin/ledgerd.js', '--help']);
assert.match(ledgerdHelp.stdout, /ledgerd 0\.2\.0/);

const ledgerdVersion = await execFileAsync(process.execPath, ['bin/ledgerd.js', '--version']);
assert.equal(ledgerdVersion.stdout.trim(), '0.2.0');

const ledgerdSmoke = await execFileAsync(process.execPath, ['bin/ledgerd.js', '--self-check']);
assert.match(ledgerdSmoke.stdout.trim(), /^ledgerd self-check ok codeManifestHash=[0-9a-f]{64}$/);

const envelope = makeEnvelope({
  command: 'entregar',
  idempotencyKey: 'self-test:entregar:1',
  actorUid: process.getuid?.() ?? null,
  runId: 'agent:neo:subagent:00000000-0000-4000-8000-000000000000',
  payload: { missaoId: 'self-test' }
});
assert.equal(envelope.command, 'entregar');

console.log('self-test ok: missao/ledgerd help/version/self-check and protocol envelope');

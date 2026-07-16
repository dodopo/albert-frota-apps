import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const demo = resolve(root, 'bin', 'uid-peer-demo.js');

const { stdout } = await execFileAsync(process.execPath, [demo]);

assert.match(stdout, /primitive=getpeereid\(3\)/);
assert.match(stdout, /real: accepted uid=\d+ gid=\d+ primitive=getpeereid\(3\)/);
assert.match(stdout, /spoof: rejected code=UID_PEER_ACTOR_MISMATCH/);

console.log('uid-peer demo ok');

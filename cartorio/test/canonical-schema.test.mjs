import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';

import {
  assertCanonicalJson,
  canonicalize,
  canonicalizeToBytes,
  computeLineHash
} from '../lib/canonical-json.js';
import {
  canonicalizeFinalEventRecord,
  finalizeEventRecord,
  normalizeRepoPath,
  SchemaError,
  validateEventRecord
} from '../lib/event-schema.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = (...parts) => resolve(root, 'fixtures', ...parts);

async function loadJsonFixture(...parts) {
  const text = await readFile(fixture(...parts), 'utf8');
  return JSON.parse(text);
}

async function loadTextFixture(...parts) {
  return readFile(fixture(...parts), 'utf8');
}

test('valid payload canonizes to exact bytes', async () => {
  const input = await loadJsonFixture('input', 'missao-entrega-valid.json');
  const expected = await loadTextFixture('expected', 'missao-entrega-valid.canonical.txt');

  const actual = canonicalizeFinalEventRecord(input);

  assert.equal(actual, expected);
  assert.equal(canonicalizeToBytes(finalizeEventRecord(input)).equals(Buffer.from(expected, 'utf8')), true);
});

test('shuffled keys and unicode normalize to the same output', async () => {
  const baseline = canonicalizeFinalEventRecord(await loadJsonFixture('input', 'missao-entrega-valid.json'));
  const shuffled = canonicalizeFinalEventRecord(await loadJsonFixture('input', 'missao-entrega-shuffled.json'));

  assert.equal(shuffled, baseline);
});

test('newline is fixed to lf and bytes are deterministic', async () => {
  const output = canonicalizeFinalEventRecord(await loadJsonFixture('input', 'missao-entrega-valid.json'));
  assert.equal(output.endsWith('\n'), true);
  assert.equal(output.includes('\r'), false);
  assert.equal(canonicalize({ z: 1, a: 2 }).endsWith('\n'), true);
  assert.doesNotThrow(() => assertCanonicalJson(output));
  assert.throws(() => assertCanonicalJson(output.trimEnd()));
  assert.throws(() => assertCanonicalJson(output.replace('\n', '\r\n')));
});

test('paths are normalized relative to the repo', () => {
  assert.equal(normalizeRepoPath('./docs/../docs/out/relatorio.md'), 'docs/out/relatorio.md');
  assert.throws(() => normalizeRepoPath('../segredo.txt'), SchemaError);
  assert.throws(() => normalizeRepoPath('/tmp/segredo.txt'), SchemaError);
  assert.throws(() => normalizeRepoPath('docs\\segredo.txt'), SchemaError);
});

test('unknown fields are rejected by closed schema', async () => {
  const input = await loadJsonFixture('input', 'missao-entrega-unknown-field.json');
  assert.throws(() => validateEventRecord(input), SchemaError);
});

test('path traversal is rejected by closed schema', async () => {
  const input = await loadJsonFixture('input', 'missao-entrega-path-traversal.json');
  assert.throws(() => validateEventRecord(input), SchemaError);
});

test('lineHash excludes itself and stays reproducible', async () => {
  const withLineHash = await loadJsonFixture('input', 'missao-entrega-self-linehash.json');
  const canonical = finalizeEventRecord(withLineHash);
  const twice = finalizeEventRecord({ ...withLineHash, lineHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' });

  assert.equal(canonical.lineHash, twice.lineHash);
  assert.equal(canonical.lineHash.length, 64);
  assert.equal(canonicalizeFinalEventRecord(withLineHash), canonicalizeFinalEventRecord({ ...withLineHash, lineHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' }));
  assert.notEqual(computeLineHash({ ...canonical, formatVersion: 'cartorio.event-schema/v2' }), canonical.lineHash);
});

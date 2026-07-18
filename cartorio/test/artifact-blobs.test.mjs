import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { collectArtifactBlobs, normalizeArtifactPath } from '../lib/artifact-blobs.js';
import { createLedgerStore, validateMissaoId } from '../lib/ledger-store.js';

const execFileAsync = promisify(execFile);
const runId = 'agent:neo:subagent:000000000000';

test('gate passo6: artefatos sao resolvidos pelo blob staged/commitado, nunca working tree', async () => {
  const t = await tempGitRepo('staged');
  try {
    await git(t.dir, ['init']);
    await git(t.dir, ['config', 'user.email', 'neo@example.invalid']);
    await git(t.dir, ['config', 'user.name', 'Neo']);
    await writeFile(join(t.app, 'report.txt'), 'staged\n', 'utf8');
    await git(t.dir, ['add', 'cartorio/report.txt']);
    await git(t.dir, ['commit', '-m', 'base']);
    await writeFile(join(t.app, 'report.txt'), 'staged-v2\n', 'utf8');
    await git(t.dir, ['add', 'cartorio/report.txt']);
    await writeFile(join(t.app, 'report.txt'), 'working-tree-v3\n', 'utf8');

    const resolved = await collectArtifactBlobs([{ path: 'report.txt' }], { cwd: t.app });

    assert.equal(resolved.artifacts[0].blobSha256, sha256('staged-v2\n'));
    assert.notEqual(resolved.artifacts[0].blobSha256, sha256('working-tree-v3\n'));
    assert.equal(resolved.artifacts[0].path, 'cartorio/report.txt');
    assert.equal(resolved.artifacts[0].gitSource, 'index');
    assert.match(resolved.commit, /^[0-9a-f]{40}$/);
  } finally {
    await t.cleanup();
  }
});

test('gate passo6: hash declarado divergente e path malicioso sao rejeitados', async () => {
  const t = await tempGitRepo('reject');
  try {
    await git(t.dir, ['init']);
    await git(t.dir, ['config', 'user.email', 'neo@example.invalid']);
    await git(t.dir, ['config', 'user.name', 'Neo']);
    await writeFile(join(t.app, 'ok.txt'), 'ok\n', 'utf8');
    await git(t.dir, ['add', 'cartorio/ok.txt']);
    await git(t.dir, ['commit', '-m', 'base']);

    await assert.rejects(
      () => collectArtifactBlobs([{ path: 'ok.txt', blobSha256: '0'.repeat(64) }], { cwd: t.app }),
      /blobSha256 diverge/
    );
    assert.throws(() => normalizeArtifactPath('../secret.txt'), /traversal|relativo/);
    assert.throws(() => normalizeArtifactPath('/tmp/secret.txt'), /relativo/);
    assert.throws(() => normalizeArtifactPath('ok\u0001.txt'), /caracteres proibidos/);
  } finally {
    await t.cleanup();
  }
});

test('gate passo6: filtros, LFS-style pointer e newline sao hashados pelo blob git', async () => {
  const t = await tempGitRepo('filters');
  try {
    await git(t.dir, ['init']);
    await git(t.dir, ['config', 'user.email', 'neo@example.invalid']);
    await git(t.dir, ['config', 'user.name', 'Neo']);
    await git(t.dir, ['config', 'filter.cartorio-test.clean', 'tr a-z A-Z']);
    await git(t.dir, ['config', 'filter.cartorio-test.smudge', 'cat']);
    await writeFile(join(t.app, '.gitattributes'), [
      'filtered.txt filter=cartorio-test',
      'crlf.txt text eol=lf',
      'large.bin filter=lfs diff=lfs merge=lfs -text',
      ''
    ].join('\n'), 'utf8');
    const lfsPointer = [
      'version https://git-lfs.github.com/spec/v1',
      'oid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'size 123',
      ''
    ].join('\n');
    await writeFile(join(t.app, 'filtered.txt'), 'blob via filter\n', 'utf8');
    await writeFile(join(t.app, 'crlf.txt'), 'line1\r\nline2\r\n', 'utf8');
    await writeFile(join(t.app, 'large.bin'), lfsPointer, 'utf8');
    await git(t.dir, ['add', 'cartorio/.gitattributes', 'cartorio/filtered.txt', 'cartorio/crlf.txt', 'cartorio/large.bin']);
    await git(t.dir, ['commit', '-m', 'filtered blobs']);
    await writeFile(join(t.app, 'filtered.txt'), 'working tree only\n', 'utf8');
    await writeFile(join(t.app, 'crlf.txt'), 'changed\r\n', 'utf8');

    const resolved = await collectArtifactBlobs([
      { path: 'filtered.txt' },
      { path: 'crlf.txt' },
      { path: 'large.bin' }
    ], { cwd: t.app });
    const byPath = Object.fromEntries(resolved.artifacts.map((artifact) => [artifact.path, artifact]));

    assert.equal(byPath['cartorio/filtered.txt'].blobSha256, sha256('BLOB VIA FILTER\n'));
    assert.equal(byPath['cartorio/crlf.txt'].blobSha256, sha256('line1\nline2\n'));
    assert.equal(byPath['cartorio/large.bin'].blobSha256, sha256(lfsPointer));
    assert.notEqual(byPath['cartorio/filtered.txt'].blobSha256, sha256(await readFile(join(t.app, 'filtered.txt'), 'utf8')));
  } finally {
    await t.cleanup();
  }
});

test('gate passo6: missaoId malicioso e rejeitado por path, controle, unicode, case e tamanho', async () => {
  const invalid = [
    '../escape',
    'ok\u0001bad',
    'cafe\u0301',
    'ABC',
    'a'.repeat(121)
  ];
  for (const missaoId of invalid) {
    assert.throws(() => validateMissaoId(missaoId), /missaoId/);
  }

  const dir = await mkdtemp(join(tmpdir(), 'cartorio-missaoid-'));
  try {
    const store = createLedgerStore({ ledgerPath: join(dir, 'missoes.jsonl') });
    await assert.rejects(
      () => store.append({
        command: 'abrir',
        missaoId: '../escape',
        idempotencyKey: 'bad',
        actorUid: process.getuid?.() ?? 0,
        runId,
        payload: { missaoId: '../escape' }
      }),
      /missaoId/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempGitRepo(name) {
  const dir = await mkdtemp(join(tmpdir(), `cartorio-artifacts-${name}-`));
  const app = join(dir, 'cartorio');
  await mkdir(app, { recursive: true });
  return {
    dir,
    app,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

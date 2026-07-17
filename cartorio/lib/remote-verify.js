import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { promisify } from 'node:util';

import { canonicalize, canonicalizeToBytes, parseCanonicalJson } from './canonical-json.js';
import { normalizeArtifactPath } from './artifact-blobs.js';
import {
  BREAK_GLASS_ROLE,
  deriveKeyIdFromPublicKey,
  publicKeyRawFromBase64,
  validateKeyring,
  validateKeyForReceiptTs,
  verifyBytes
} from './keyring.js';
import { verifyReceipt } from './receipt.js';
import { computeCodeManifestHash } from './uid-peer.js';

const execFileAsync = promisify(execFile);
const KEYRING_PATH = '.cartorio/keys/keyring.json';
const RECEIPT_DIR = '.cartorio/missoes';
const BREAK_GLASS_DIR = '.cartorio/break-glass';
const CODE_MANIFEST_PATH = 'build/uid-peer-helper.manifest.json';
export const TREE_SCOPE_V1 = 'cartorio.git-tree.v1:app-files-excluding-mission-receipts';
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const HEX_COMMIT = /^[0-9a-f]{40,64}$/;
const RUN_ID_PATTERN = /^(agent:[a-z0-9._-]+:subagent:[0-9a-fA-F-]{12,}|human:[a-z0-9._:-]+|manual:[a-z0-9._:-]+)$/;
const BREAK_GLASS_REQUIRED = [
  'id',
  'motivo',
  'commit',
  'artefatos',
  'autorizadoPor',
  'ts',
  'expiry',
  'incidentRef',
  'keyId'
];

export async function verifyRemoteReceipt({
  repo = process.cwd(),
  commit = 'HEAD',
  appDir = null,
  now = new Date(),
  expectedBootstrapKeyringFingerprint = process.env.CARTORIO_BOOTSTRAP_KEYRING_FINGERPRINT ?? null,
  bootstrapBaseRef = process.env.CARTORIO_BOOTSTRAP_BASE_REF ?? null
} = {}) {
  const context = await gitContext(repo, commit, appDir);
  const observedAt = now.toISOString();
  const keyringPath = appPath(context, KEYRING_PATH);
  const keyringAtHead = await tryReadJsonAtCommit(context, keyringPath);
  if (!keyringAtHead.ok) {
    throw remoteError('KEYRING_MISSING', 'keyring ausente no commit verificado', { keyringPath });
  }
  const parentKeyring = await tryReadJsonAtCommit({ ...context, commit: context.parentCommit }, keyringPath);
  if (!parentKeyring.ok) {
    return validateBootstrapAtCommit({
      context,
      keyringPath,
      keyringAtHead: keyringAtHead.value,
      observedAt,
      expectedFingerprint: expectedBootstrapKeyringFingerprint,
      bootstrapBaseRef
    });
  }
  const keyring = parentKeyring.value;
  validateKeyring(keyring);
  const manifest = await readJsonAtCommit(context, appPath(context, CODE_MANIFEST_PATH));
  validateCodeManifest(manifest);

  const changed = await changedFilesForCommit(context);
  const missionReceipts = changed.filter((entry) => isReceiptPath(unappPath(context, entry)));
  if (missionReceipts.length > 1) {
    throw remoteError('REMOTE_RECEIPT_COUNT_INVALID', 'PR precisa conter exatamente um receipt de missao', {
      receiptCount: missionReceipts.length,
      receiptPaths: missionReceipts
    });
  }
  if (missionReceipts.length === 1 && keyringFingerprint(keyringAtHead.value) !== keyringFingerprint(parentKeyring.value)) {
    throw remoteError('KEYRING_CHANGED_WITH_RECEIPT', 'receipt-valid valida contra keyring herdado e recusa keyring alterado no mesmo commit', {
      keyringPath,
      receiptPath: missionReceipts[0]
    });
  }
  const receiptResults = [];
  for (const path of missionReceipts) {
    try {
      const receipt = await readJsonAtCommit(context, path);
      const result = await validateReceiptAtCommit({ context, path, receipt, keyring, manifest });
      return {
        ok: true,
        state: 'receipt-valid',
        commit: context.commit,
        parentCommit: context.parentCommit,
        observedAt,
        receiptPath: path,
        missaoId: result.receipt.missaoId,
        ledgerSeq: result.receipt.ledgerSeq,
        runId: result.receipt.runId,
        keyId: result.keyId,
        treeScope: result.receipt.treeScope,
        treeHashExcludingReceipts: result.receipt.treeHashExcludingReceipts,
        codeManifestHash: result.receipt.codeManifestHash
      };
    } catch (error) {
      receiptResults.push({ path, ok: false, code: error.code ?? error.name ?? 'RECEIPT_INVALID', message: error.message });
    }
  }

  const breakGlassCandidates = await listFilesAtCommit(context, appPath(context, BREAK_GLASS_DIR));
  const breakGlassResults = [];
  for (const path of breakGlassCandidates.filter((entry) => entry.endsWith('.json'))) {
    try {
      const artifact = await readJsonAtCommit(context, path);
      const result = await validateBreakGlassAtCommit({ context, path, artifact, keyring, now });
      return {
        ok: true,
        state: 'break-glass-valid',
        exception: true,
        exceptionState: 'BREAK_GLASS_EXCEPTION',
        commit: context.commit,
        targetCommit: result.artifact.commit,
        observedAt,
        breakGlassPath: path,
        id: result.artifact.id,
        incidentRef: result.artifact.incidentRef,
        autorizadoPor: result.artifact.autorizadoPor,
        expiry: result.artifact.expiry,
        keyId: result.artifact.keyId
      };
    } catch (error) {
      breakGlassResults.push({ path, ok: false, code: error.code ?? error.name ?? 'BREAK_GLASS_INVALID', message: error.message });
    }
  }

  throw remoteError('REMOTE_VERIFY_FAIL', 'nenhum receipt ou break-glass valido no commit', {
    state: 'fail',
    commit: context.commit,
    parentCommit: context.parentCommit,
    observedAt,
    receiptResults,
    breakGlassResults
  });
}

async function validateBootstrapAtCommit({ context, keyringPath, keyringAtHead, observedAt, expectedFingerprint, bootstrapBaseRef }) {
  if (!expectedFingerprint) {
    throw remoteError('BOOTSTRAP_FINGERPRINT_MISSING', 'bootstrap-valid exige fingerprint esperado fora do repo');
  }
  validateKeyring(keyringAtHead);
  const actualFingerprint = keyringFingerprint(keyringAtHead);
  if (actualFingerprint !== expectedFingerprint) {
    throw remoteError('BOOTSTRAP_FINGERPRINT_MISMATCH', 'fingerprint do keyring inicial diverge do esperado externo', {
      expectedFingerprint,
      actualFingerprint
    });
  }
  const changed = await changedFilesForCommit(context);
  if (changed.length !== 1 || changed[0] !== keyringPath) {
    throw remoteError('BOOTSTRAP_DIFF_NOT_EXCLUSIVE', 'bootstrap-valid exige diff exclusivo do keyring', {
      changedFiles: changed,
      expectedOnly: keyringPath
    });
  }
  const baseRef = await resolveBootstrapBaseRef(context, bootstrapBaseRef);
  const existsInMain = await keyringExistsInHistory(context, baseRef, keyringPath);
  if (existsInMain) {
    throw remoteError('BOOTSTRAP_ALREADY_USED', 'keyring ja existe no historico da main; bootstrap auto-inutilizado', {
      baseRef,
      keyringPath
    });
  }
  return {
    ok: true,
    state: 'bootstrap-valid',
    commit: context.commit,
    parentCommit: context.parentCommit,
    observedAt,
    keyringPath,
    keyringFingerprint: actualFingerprint,
    baseRef
  };
}

async function validateReceiptAtCommit({ context, path, receipt, keyring, manifest }) {
  validateReceiptHistoryFields(receipt);
  validateReceiptPathMatchesMission(path, receipt);
  const tree = await computeTreeHashExcludingReceipts(context);
  const expectedArtifacts = [];
  for (const artifact of receipt.artefatos) {
    expectedArtifacts.push(await artifactHashAtCommit(context, artifact.path));
  }
  const result = await verifyReceipt(receipt, {
    keyring,
    expectedParentCommit: context.parentCommit,
    expectedTreeScope: TREE_SCOPE_V1,
    expectedTreeHashExcludingReceipts: tree.treeHashExcludingReceipts,
    expectedArtifacts
  });
  if (receipt.codeManifestHash !== manifest.codeManifestHash) {
    throw remoteError('RECEIPT_CODE_MANIFEST_MISMATCH', 'codeManifestHash do receipt diverge do manifesto versionado', {
      receiptCodeManifestHash: receipt.codeManifestHash,
      manifestCodeManifestHash: manifest.codeManifestHash
    });
  }
  if (receipt.buildId != null && receipt.buildId !== manifest.buildId) {
    throw remoteError('RECEIPT_BUILD_ID_MISMATCH', 'buildId do receipt diverge do manifesto versionado', {
      receiptBuildId: receipt.buildId,
      manifestBuildId: manifest.buildId
    });
  }
  return result;
}

async function validateBreakGlassAtCommit({ context, path, artifact, keyring, now }) {
  validateBreakGlassShape(artifact);
  await assertCommitObjectReachable(context, artifact.commit, 'BREAK_GLASS_TARGET_UNAVAILABLE');
  if (Date.parse(artifact.expiry) <= now.getTime()) {
    throw remoteError('BREAK_GLASS_EXPIRED', 'break-glass expirado', {
      expiry: artifact.expiry,
      observedAt: now.toISOString()
    });
  }
  const entry = keyring[artifact.keyId];
  if (!entry) {
    throw remoteError('BREAK_GLASS_UNKNOWN_KEY', 'keyId do break-glass ausente do keyring', { keyId: artifact.keyId });
  }
  const pubRaw = publicKeyRawFromBase64(entry.pub, artifact.keyId);
  const derived = deriveKeyIdFromPublicKey(pubRaw);
  if (derived !== artifact.keyId) {
    throw remoteError('BREAK_GLASS_KEYID_MISMATCH', 'keyId nao e sha256(pub) truncado', {
      keyId: artifact.keyId,
      derived
    });
  }
  validateKeyForReceiptTs(entry, artifact.keyId, artifact.ts, { role: BREAK_GLASS_ROLE });
  const material = { ...artifact };
  delete material.signature;
  if (!verifyBytes(pubRaw, canonicalizeToBytes(material), Buffer.from(artifact.signature, 'base64'))) {
    throw remoteError('BREAK_GLASS_SIGNATURE_INVALID', 'assinatura Ed25519 do break-glass invalida', {
      keyId: artifact.keyId
    });
  }
  for (const declared of artifact.artefatos) {
    const actual = await artifactHashAtCommit({ ...context, commit: artifact.commit }, declared.path);
    if (declared.blobSha256 !== actual.blobSha256) {
      throw remoteError('BREAK_GLASS_ARTIFACT_MISMATCH', 'blobSha256 do break-glass diverge do blob do commit alvo', {
        path: actual.path,
        expectedBlobSha256: actual.blobSha256,
        declaredBlobSha256: declared.blobSha256
      });
    }
  }
  await assertBreakGlassSingleUse(context, path, artifact.id);
  return { artifact };
}

function validateReceiptPathMatchesMission(path, receipt) {
  if (basename(path) !== `${receipt.missaoId}.receipt.json`) {
    throw remoteError('RECEIPT_PATH_MISMATCH', 'nome do receipt diverge do missaoId assinado', {
      path,
      missaoId: receipt.missaoId
    });
  }
}

function validateReceiptHistoryFields(receipt) {
  if (!RUN_ID_PATTERN.test(receipt.runId)) {
    throw remoteError('RECEIPT_RUN_ID_INVALID', 'runId fora do formato verificavel', { runId: receipt.runId });
  }
}

function validateBreakGlassShape(artifact) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw remoteError('BREAK_GLASS_INVALID', 'break-glass precisa ser objeto');
  }
  for (const field of BREAK_GLASS_REQUIRED) {
    if (field === 'artefatos') {
      continue;
    }
    assertNonEmptyString(artifact[field], field);
  }
  assertHex(artifact.commit, 'commit', HEX_COMMIT);
  assertNonEmptyString(artifact.signature, 'signature');
  if (!Array.isArray(artifact.artefatos) || artifact.artefatos.length === 0) {
    throw remoteError('BREAK_GLASS_INVALID', 'artefatos obrigatorio e nao-vazio');
  }
  for (const item of artifact.artefatos) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw remoteError('BREAK_GLASS_INVALID', 'artefato precisa ser objeto');
    }
    assertNonEmptyString(item.path, 'artefato.path');
    assertHex(item.blobSha256, 'artefato.blobSha256', HEX_SHA256);
  }
  assertIso(artifact.ts, 'ts');
  assertIso(artifact.expiry, 'expiry');
}

function validateCodeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw remoteError('CODE_MANIFEST_INVALID', 'manifesto de codigo precisa ser objeto');
  }
  if (manifest.schema !== 'cartorio.uid-peer-helper.manifest/v1') {
    throw remoteError('CODE_MANIFEST_INVALID', 'schema do manifesto de codigo invalido', { schema: manifest.schema });
  }
  assertNonEmptyString(manifest.buildId, 'buildId');
  assertHex(manifest.codeManifestHash, 'codeManifestHash', HEX_SHA256);
  const computed = computeCodeManifestHash(manifest);
  if (computed !== manifest.codeManifestHash) {
    throw remoteError('CODE_MANIFEST_HASH_MISMATCH', 'codeManifestHash diverge do manifesto versionado', {
      expected: computed,
      declared: manifest.codeManifestHash
    });
  }
}

export async function computeTreeHashExcludingReceipts(context) {
  const prefix = context.appDir ? `${context.appDir}/` : '';
  const rootPath = context.appDir || '.';
  const files = await listFilesAtCommit(context, rootPath);
  const entries = [];
  for (const gitPath of files) {
    if (!gitPath || gitPath === '.') {
      continue;
    }
    const scopedPath = prefix && gitPath.startsWith(prefix) ? gitPath.slice(prefix.length) : gitPath;
    if (isReceiptPath(scopedPath)) {
      continue;
    }
    entries.push(await artifactHashAtCommit(context, scopedPath));
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en', { sensitivity: 'variant' }));
  return {
    treeScope: TREE_SCOPE_V1,
    treeHashExcludingReceipts: sha256(canonicalize(entries)),
    entries
  };
}

function isReceiptPath(path) {
  return /^\.cartorio\/missoes\/[^/]+\.receipt\.json$/.test(path);
}

async function assertBreakGlassSingleUse(context, _path, id) {
  const log = await git(['log', '--all', '--format=%H'], context.repo);
  const commits = log.stdout.trim().split('\n').filter(Boolean);
  const usedForCommits = new Set();
  for (const rev of commits) {
    const candidateContext = { ...context, commit: rev };
    const files = await listFilesAtCommit(candidateContext, appPath(candidateContext, BREAK_GLASS_DIR));
    for (const file of files.filter((entry) => entry.endsWith('.json'))) {
      try {
        const candidate = await readJsonAtCommit(candidateContext, file);
        if (candidate.id === id && typeof candidate.commit === 'string') {
          usedForCommits.add(candidate.commit);
        }
      } catch {
        // Conteudo historico malformado nao e evidencia valida de uso deste id.
      }
    }
  }
  if (usedForCommits.size > 1) {
    throw remoteError('BREAK_GLASS_ID_REUSED', 'break-glass id aparece usado em mais de um commit alvo no historico', {
      id,
      commits: [...usedForCommits].sort()
    });
  }
}

async function artifactHashAtCommit(context, path) {
  const normalizedPath = normalizeArtifactPath(path);
  const gitPath = appPath(context, normalizedPath);
  const blob = await git(['cat-file', 'blob', `${context.commit}:${gitPath}`], context.repo, { encoding: 'buffer' });
  return {
    path: normalizedPath,
    blobSha256: createHash('sha256').update(blob.stdout).digest('hex')
  };
}

async function gitContext(repo, commitish, appDirOption = null) {
  const root = (await git(['rev-parse', '--show-toplevel'], repo)).stdout.trim();
  const prefix = (await git(['rev-parse', '--show-prefix'], repo)).stdout.trim().replace(/\/$/, '');
  const commit = (await git(['rev-parse', '--verify', `${commitish}^{commit}`], root)).stdout.trim();
  const parentCommit = await firstParent(root, commit);
  await assertCommitObjectReachable({ repo: root }, parentCommit, 'GIT_PARENT_UNAVAILABLE');
  const appDir = normalizeAppDir(appDirOption ?? prefix);
  return { repo: root, commit, parentCommit, appDir };
}

async function firstParent(repo, commit) {
  const line = (await git(['rev-list', '--parents', '-n', '1', commit], repo)).stdout.trim();
  const [, parent] = line.split(/\s+/);
  if (!parent) {
    throw remoteError('GIT_PARENT_UNAVAILABLE', 'commit sem pai nao atende fetch-depth minimo do required check', { commit });
  }
  return parent;
}

async function assertCommitObjectReachable(context, commit, code) {
  const result = await tryGit(['cat-file', '-e', `${commit}^{commit}`], context.repo);
  if (!result.ok) {
    throw remoteError(code, 'commit necessario nao esta disponivel no clone', { commit });
  }
}

async function listFilesAtCommit(context, path) {
  const result = await tryGit(['ls-tree', '-r', '--name-only', context.commit, path], context.repo);
  if (!result.ok) {
    return [];
  }
  return result.stdout.trim().split('\n').filter(Boolean);
}

async function readJsonAtCommit(context, path) {
  const result = await git(['cat-file', 'blob', `${context.commit}:${path}`], context.repo);
  return parseJsonText(result.stdout, path);
}

async function tryReadJsonAtCommit(context, path) {
  const result = await tryGit(['cat-file', 'blob', `${context.commit}:${path}`], context.repo);
  if (!result.ok) {
    return { ok: false, error: result.stderr };
  }
  return { ok: true, value: parseJsonText(result.stdout, path) };
}

async function changedFilesForCommit(context) {
  const result = await git(['diff-tree', '--no-commit-id', '--name-only', '-r', context.commit], context.repo);
  return result.stdout.trim().split('\n').filter(Boolean).sort();
}

async function resolveBootstrapBaseRef(context, configuredRef) {
  const candidates = [configuredRef, 'origin/main', 'main'].filter(Boolean);
  for (const ref of candidates) {
    const result = await tryGit(['rev-parse', '--verify', `${ref}^{commit}`], context.repo);
    if (result.ok) {
      return ref;
    }
  }
  throw remoteError('BOOTSTRAP_BASE_REF_UNAVAILABLE', 'referencia da main indisponivel para validar bootstrap', {
    candidates
  });
}

async function keyringExistsInHistory(context, ref, keyringPath) {
  const result = await tryGit(['log', '--format=%H', ref, '--', keyringPath], context.repo);
  if (!result.ok) {
    throw remoteError('BOOTSTRAP_HISTORY_UNAVAILABLE', 'falha ao consultar historico da main para keyring', {
      ref,
      keyringPath,
      stderr: result.stderr
    });
  }
  return result.stdout.trim().length > 0;
}

function parseJsonText(text, path) {
  try {
    return parseCanonicalJson(text);
  } catch {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw remoteError('JSON_INVALID', 'JSON invalido no commit', { path, cause: error.message });
    }
  }
}

async function tryGit(args, cwd, options = {}) {
  try {
    const result = await git(args, cwd, options);
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message
    };
  }
}

async function git(args, cwd, options = {}) {
  try {
    return await execFileAsync('git', args, {
      cwd,
      encoding: options.encoding ?? 'utf8',
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 64
    });
  } catch (error) {
    throw remoteError('GIT_COMMAND_FAILED', `git ${args.join(' ')} falhou`, {
      cwd,
      stderr: error.stderr ?? null,
      stdout: error.stdout ?? null
    });
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw remoteError('FIELD_INVALID', `${field} obrigatorio`, { field });
  }
}

function assertHex(value, field, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw remoteError('FIELD_INVALID', `${field} invalido`, { field, value });
  }
}

function assertIso(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw remoteError('FIELD_INVALID', `${field} precisa ser ISO instant`, { field, value });
  }
}

function remoteError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function appPath(context, path) {
  const normalizedPath = String(path ?? '').replace(/^\/+/, '');
  if (!context.appDir || normalizedPath.startsWith(`${context.appDir}/`) || normalizedPath === context.appDir) {
    return normalizedPath;
  }
  return `${context.appDir}/${normalizedPath}`;
}

function unappPath(context, path) {
  const normalizedPath = String(path ?? '').replace(/^\/+/, '');
  if (!context.appDir) {
    return normalizedPath;
  }
  const prefix = `${context.appDir}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

function normalizeAppDir(value) {
  if (value == null || value === '' || value === '.') {
    return '';
  }
  const normalized = String(value).replace(/^\/+|\/+$/g, '');
  if (normalized.includes('..') || normalized.includes('\\')) {
    throw remoteError('APP_DIR_INVALID', 'appDir invalido', { appDir: value });
  }
  return normalized;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function keyringFingerprint(keyring) {
  return sha256(canonicalize(keyring));
}

export function formatRemoteResult(result) {
  return canonicalize(result);
}

export function formatRemoteError(error) {
  return canonicalize({
    ok: false,
    state: 'fail',
    code: error.code ?? error.name ?? 'REMOTE_VERIFY_ERROR',
    message: error.message,
    details: error.details ?? null
  });
}

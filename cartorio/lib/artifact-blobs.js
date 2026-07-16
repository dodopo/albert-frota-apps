import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { GitContextMissingError, InvalidStateError } from './protocol.js';

const execFileAsync = promisify(execFile);
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SAFE_REPO_PATH = /^[A-Za-z0-9._/-]+$/;

export async function hashArtifactBlob(path, options = {}) {
  return resolveArtifactBlob({ path }, options);
}

export async function collectArtifactBlobs(artifacts = [], options = {}) {
  const normalizedArtifacts = artifacts.map((artifact) => (
    typeof artifact === 'string' ? { path: artifact } : artifact
  ));
  const context = await gitContext(options);
  const resolved = [];
  for (const artifact of normalizedArtifacts) {
    resolved.push(await resolveArtifactBlob(artifact, { ...options, context }));
  }
  return {
    commit: context.commit,
    repoRoot: context.repoRoot,
    artifacts: resolved
  };
}

export function normalizeArtifactPath(path) {
  if (typeof path !== 'string') {
    throw new InvalidStateError('artifact path precisa ser string');
  }
  if (path.length === 0 || path.length > 512) {
    throw new InvalidStateError('artifact path com tamanho invalido', { pathLength: path.length });
  }
  if (path !== path.normalize('NFC') || CONTROL.test(path) || path.includes('\\') || path.includes(':')) {
    throw new InvalidStateError('artifact path contem caracteres proibidos', { path });
  }
  if (path.startsWith('/') || path.startsWith('~')) {
    throw new InvalidStateError('artifact path precisa ser relativo ao repo', { path });
  }

  const trimmed = path.replace(/^\.\//, '');
  if (!SAFE_REPO_PATH.test(trimmed)) {
    throw new InvalidStateError('artifact path fora do conjunto ASCII permitido', { path });
  }
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new InvalidStateError('artifact path traversal rejeitado', { path });
  }
  return parts.join('/');
}

async function resolveArtifactBlob(artifact, options = {}) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new InvalidStateError('artefato precisa ser objeto');
  }

  const context = options.context ?? await gitContext(options);
  const declaredPath = normalizeArtifactPath(artifact.path);
  const repoPath = toRepoPath(declaredPath, context.prefix);
  const declaredBlobSha256 = artifact.blobSha256 == null ? null : String(artifact.blobSha256).toLowerCase();
  if (declaredBlobSha256 != null && !HEX_SHA256.test(declaredBlobSha256)) {
    throw new InvalidStateError('artifact blobSha256 invalido', { path: declaredPath });
  }

  const object = await resolveGitBlobObject(repoPath, context);
  const blob = await git(['cat-file', 'blob', object.oid], {
    cwd: context.repoRoot,
    encoding: 'buffer',
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 256
  });
  const blobSha256 = createHash('sha256').update(blob.stdout).digest('hex');
  if (declaredBlobSha256 != null && declaredBlobSha256 !== blobSha256) {
    throw new InvalidStateError('artifact blobSha256 diverge do blob git', {
      path: repoPath,
      expectedBlobSha256: blobSha256,
      declaredBlobSha256
    });
  }

  return {
    path: repoPath,
    blobSha256,
    gitBlobOid: object.oid,
    gitSource: object.source,
    commit: context.commit
  };
}

async function resolveGitBlobObject(repoPath, context) {
  const indexObject = await tryGit(['rev-parse', '--verify', `:${repoPath}`], { cwd: context.repoRoot });
  if (indexObject.ok) {
    return {
      oid: indexObject.stdout.trim(),
      source: 'index'
    };
  }

  const commitObject = await tryGit(['rev-parse', '--verify', `${context.commit}:${repoPath}`], { cwd: context.repoRoot });
  if (commitObject.ok) {
    return {
      oid: commitObject.stdout.trim(),
      source: 'commit'
    };
  }

  throw new InvalidStateError('artifact path nao existe no blob git alvo', {
    path: repoPath,
    commit: context.commit,
    indexError: indexObject.stderr.trim(),
    commitError: commitObject.stderr.trim()
  });
}

async function gitContext({ cwd = process.cwd(), commit } = {}) {
  const rootResult = await tryGit(['rev-parse', '--show-toplevel'], { cwd });
  if (!rootResult.ok) {
    throw new GitContextMissingError('git rev-parse --show-toplevel falhou', {
      cwd,
      stderr: rootResult.stderr.trim(),
      stdout: rootResult.stdout.trim()
    });
  }
  const repoRoot = rootResult.stdout.trim();
  const prefix = (await gitText(['rev-parse', '--show-prefix'], { cwd })).trim();
  const targetCommit = commit
    ? (await gitText(['rev-parse', '--verify', `${commit}^{commit}`], { cwd: repoRoot })).trim()
    : (await gitText(['rev-parse', '--verify', 'HEAD'], { cwd: repoRoot })).trim();
  return {
    cwd,
    repoRoot,
    prefix,
    commit: targetCommit
  };
}

function toRepoPath(path, prefix) {
  if (!prefix || path === prefix.slice(0, -1) || path.startsWith(prefix)) {
    return path;
  }
  return `${prefix}${path}`;
}

async function gitText(args, options) {
  const result = await git(args, { ...options, encoding: 'utf8' });
  return result.stdout;
}

async function tryGit(args, options) {
  try {
    const result = await git(args, { ...options, encoding: 'utf8' });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message
    };
  }
}

async function git(args, options = {}) {
  try {
    return await execFileAsync('git', args, {
      cwd: options.cwd,
      encoding: options.encoding ?? 'utf8',
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 16
    });
  } catch (error) {
    throw Object.assign(new InvalidStateError(`git ${args.join(' ')} falhou`, {
      cwd: options.cwd,
      stderr: error.stderr ?? null,
      stdout: error.stdout ?? null
    }), { cause: error });
  }
}

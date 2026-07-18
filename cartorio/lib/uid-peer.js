import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from './canonical-json.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

export const uidPeerHelperSource = join(repoRoot, 'native', 'uid-peer-helper.c');
export const uidPeerHelperBinary = join(repoRoot, 'build', 'uid-peer-helper');
export const uidPeerHelperManifest = join(repoRoot, 'build', 'uid-peer-helper.manifest.json');

export function describePeerAuth() {
  return {
    mode: 'native-helper',
    helperSource: uidPeerHelperSource,
    helperBinary: uidPeerHelperBinary,
    manifest: uidPeerHelperManifest,
    primitive: 'getpeereid(3)',
    requiredProductionMode: 'native-accept-with-kernel-peer-credential',
    runtimePolicy: 'fail-closed: runtime never builds, only verifies manifest/hash then execs helper',
    note: 'O helper nativo possui accept(2) do UDS e retorna UID/GID obtidos do kernel; JS nao usa _handle.fd.'
  };
}

export async function buildUidPeerHelper({ cc = 'cc', force = false, manifestPath = uidPeerHelperManifest } = {}) {
  if (!force && existsSync(uidPeerHelperBinary)) {
    await verifyUidPeerHelperManifest({ manifestPath });
    return uidPeerHelperBinary;
  }

  await mkdir(dirname(uidPeerHelperBinary), { recursive: true });
  const args = [
    '-Wall',
    '-Wextra',
    '-Werror',
    '-O2',
    '-o',
    uidPeerHelperBinary,
    uidPeerHelperSource
  ];
  await runProcess(cc, args);

  const binaryHash = await sha256File(uidPeerHelperBinary);
  const sourceHash = await sha256File(uidPeerHelperSource);
  const manifest = {
    schema: 'cartorio.uid-peer-helper.manifest/v1',
    buildId: `uid-peer-helper:${binaryHash.slice(0, 16)}`,
    binarySha256: binaryHash,
    sourceSha256: sourceHash,
    primitive: 'getpeereid(3)',
    signature: null
  };
  manifest.codeManifestHash = computeCodeManifestHash(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    helperPath: uidPeerHelperBinary,
    manifestPath,
    binarySha256: binaryHash,
    codeManifestHash: manifest.codeManifestHash
  };
}

export async function verifyUidPeerHelperManifest({
  helperPath = uidPeerHelperBinary,
  manifestPath = uidPeerHelperManifest
} = {}) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw Object.assign(
      new Error(`uid-peer helper manifest missing or invalid: ${manifestPath}`),
      { code: 'UID_PEER_MANIFEST_INVALID', manifestPath, cause: error }
    );
  }

  if (manifest.schema !== 'cartorio.uid-peer-helper.manifest/v1') {
    throw Object.assign(
      new Error(`uid-peer helper manifest schema unsupported: ${manifest.schema}`),
      { code: 'UID_PEER_MANIFEST_INVALID', manifestPath, manifest }
    );
  }
  assertManifestString(manifest.binarySha256, 'binarySha256', manifestPath);

  try {
    const st = await stat(helperPath);
    if (!st.isFile() || (st.mode & 0o111) === 0) {
      throw new Error('helper is not an executable file');
    }
  } catch (error) {
    throw Object.assign(
      new Error(`uid-peer helper binary missing or not executable: ${helperPath}`),
      { code: 'UID_PEER_HELPER_UNTRUSTED', helperPath, cause: error }
    );
  }

  const actualBinaryHash = await sha256File(helperPath);
  if (actualBinaryHash !== manifest.binarySha256) {
    throw Object.assign(
      new Error('uid-peer helper binary hash diverges from manifest'),
      { code: 'UID_PEER_HELPER_UNTRUSTED', helperPath, manifestPath, expected: manifest.binarySha256, actual: actualBinaryHash }
    );
  }

  const actualCodeManifestHash = computeCodeManifestHash(manifest);
  if (manifest.codeManifestHash !== actualCodeManifestHash) {
    throw Object.assign(
      new Error('uid-peer helper codeManifestHash diverges from manifest material'),
      { code: 'UID_PEER_HELPER_UNTRUSTED', helperPath, manifestPath, expected: manifest.codeManifestHash, actual: actualCodeManifestHash }
    );
  }

  return {
    helperPath,
    manifestPath,
    binarySha256: actualBinaryHash,
    codeManifestHash: manifest.codeManifestHash,
    buildId: manifest.buildId,
    signature: manifest.signature
  };
}

export function computeCodeManifestHash(manifest) {
  const material = {
    schema: manifest.schema,
    binarySha256: manifest.binarySha256,
    sourceSha256: manifest.sourceSha256,
    primitive: manifest.primitive
  };
  return createHash('sha256').update(canonicalize(material), 'utf8').digest('hex');
}

function assertManifestString(manifestValue, field, manifestPath) {
  if (typeof manifestValue !== 'string' || manifestValue.length === 0) {
    throw Object.assign(
      new Error(`uid-peer helper manifest field missing or invalid: ${field}`),
      { code: 'UID_PEER_MANIFEST_INVALID', manifestPath, field }
    );
  }
}

export async function acceptAuthenticatedPeer({
  socketPath,
  actor,
  helperPath = uidPeerHelperBinary,
  manifestPath = uidPeerHelperManifest,
  verifyManifest = true,
  timeoutMs = 5000,
  socketMode = '0660',
  enforceClaimedActor = true,
  onListening
} = {}) {
  if (!socketPath) {
    throw new TypeError('uid-peer.acceptAuthenticatedPeer requer socketPath');
  }

  let manifestEvidence = null;
  if (verifyManifest) {
    manifestEvidence = await verifyUidPeerHelperManifest({ helperPath, manifestPath });
  }

  const helper = spawn(helperPath, ['--accept-once', socketPath, '--socket-mode', socketMode], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  let listeningNotified = false;

  const timer = setTimeout(() => {
    helper.kill('SIGTERM');
  }, timeoutMs);

  helper.stdout.setEncoding('utf8');
  helper.stderr.setEncoding('utf8');

  helper.stdout.on('data', (chunk) => {
    stdout += chunk;
  });

  helper.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (!listeningNotified && stderr.includes('listening path=')) {
      listeningNotified = true;
      onListening?.({ socketPath, stderr });
    }
  });

  const exit = await new Promise((resolve, reject) => {
    helper.once('error', reject);
    helper.once('close', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));

  if (exit.code !== 0) {
    throw Object.assign(
      new Error(`uid-peer helper failed code=${exit.code} signal=${exit.signal ?? 'none'} stderr=${stderr.trim()}`),
      { code: 'UID_PEER_HELPER_FAILED', helperPath, stderr, exit }
    );
  }

  const peer = parseHelperOutput(stdout, stderr);
  const claimedActor = parseClaimedActor(peer.payload);
  if (enforceClaimedActor) {
    assertPeerMatchesActor(peer, claimedActor);
  }
  assertPeerMatchesActor(peer, actor);

  return {
    uid: peer.uid,
    gid: peer.gid,
    primitive: peer.primitive,
    helperPath,
    socketPath,
    claimedActor,
    payload: peer.payload,
    manifest: manifestEvidence,
    evidence: {
      stdout: stdout.trim(),
      stderr: stderr.trim()
    }
  };
}

export function assertPeerMatchesActor(peer, actor) {
  if (!actor) {
    return true;
  }

  const normalized = normalizeActor(actor);
  if (normalized.uid != null && Number(peer.uid) !== normalized.uid) {
    throw Object.assign(
      new Error(`uid-peer actor mismatch: peer uid=${peer.uid} actor uid=${normalized.uid}`),
      { code: 'UID_PEER_ACTOR_MISMATCH', peer, actor: normalized }
    );
  }

  if (normalized.gid != null && Number(peer.gid) !== normalized.gid) {
    throw Object.assign(
      new Error(`uid-peer actor mismatch: peer gid=${peer.gid} actor gid=${normalized.gid}`),
      { code: 'UID_PEER_ACTOR_MISMATCH', peer, actor: normalized }
    );
  }

  return true;
}

function parseHelperOutput(stdout, stderr) {
  const line = stdout.trim().split(/\r?\n/).find(Boolean);
  if (!line) {
    throw Object.assign(
      new Error(`uid-peer helper did not emit JSON stdout; stderr=${stderr.trim()}`),
      { code: 'UID_PEER_BAD_OUTPUT', stdout, stderr }
    );
  }

  const parsed = JSON.parse(line);
  if (!parsed.ok || !Number.isInteger(parsed.uid) || !Number.isInteger(parsed.gid)) {
    throw Object.assign(
      new Error(`uid-peer helper emitted invalid peer JSON: ${line}`),
      { code: 'UID_PEER_BAD_OUTPUT', parsed }
    );
  }
  return parsed;
}

function parseClaimedActor(payload) {
  if (!payload) {
    return null;
  }

  const trimmed = payload.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = JSON.parse(trimmed);
  return normalizeActor(parsed);
}

function normalizeActor(actor) {
  if (!actor) {
    return null;
  }

  const uid = actor.uid ?? actor.actorUid ?? actor.atorUid;
  const gid = actor.gid ?? actor.actorGid ?? actor.atorGid;

  return {
    uid: uid == null ? null : Number(uid),
    gid: gid == null ? null : Number(gid)
  };
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(
        new Error(`${command} failed code=${code} signal=${signal ?? 'none'} stderr=${stderr.trim()}`),
        { code: 'UID_PEER_BUILD_FAILED', command, args, stdout, stderr }
      ));
    });
  });
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

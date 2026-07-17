#!/usr/bin/env node
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedgerStore } from '../lib/ledger-store.js';
import { canonicalize, parseCanonicalJson } from '../lib/canonical-json.js';
import { errorResponse, exitCodeForProtocolCode, InvalidStateError, okResponse, protocolVersion } from '../lib/protocol.js';
import {
  acceptAuthenticatedPeer,
  buildUidPeerHelper,
  describePeerAuth,
  verifyUidPeerHelperManifest
} from '../lib/uid-peer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const HELP = `ledgerd ${packageJson.version}

Uso:
  ledgerd [--help] [--version]
  ledgerd --build-uid-helper
  ledgerd --self-check
  ledgerd --append-json '<json>' --ledger <path>
  ledgerd --serve-once <socket> --ledger <path>

Daemon escritor unico minimo do Cartorio.
Protocolo: ${protocolVersion}`;

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || has(argv, '--help') || has(argv, '-h')) {
    console.log(HELP);
    return 0;
  }

  if (has(argv, '--version') || has(argv, '-v')) {
    console.log(packageJson.version);
    return 0;
  }

  if (has(argv, '--build-uid-helper')) {
    const built = await buildUidPeerHelper({ force: true });
    console.log(JSON.stringify(built));
    return 0;
  }

  if (has(argv, '--self-check')) {
    const manifest = await verifyUidPeerHelperManifest(helperOptions(argv));
    console.log(`ledgerd self-check ok codeManifestHash=${manifest.codeManifestHash}`);
    return 0;
  }

  const ledgerPath = valueAfter(argv, '--ledger') ?? process.env.CARTORIO_LEDGER_PATH;
  const store = createLedgerStore({ ledgerPath, codeManifestHash: process.env.CARTORIO_CODE_MANIFEST_HASH ?? null });

  if (has(argv, '--append-json')) {
    const input = JSON.parse(valueAfter(argv, '--append-json'));
    const result = await store.append(input);
    console.log(JSON.stringify(result));
    return 0;
  }

  const socketPath = valueAfter(argv, '--serve-once');
  if (socketPath) {
    const manifest = await verifyUidPeerHelperManifest(helperOptions(argv));
    const peer = await acceptAuthenticatedPeer({
      socketPath,
      ...helperOptions(argv),
      enforceClaimedActor: false,
      onListening: () => notifyParentReady(socketPath)
    });
    const response = await handlePeerRequest({ store, peer, manifest });
    console.log(JSON.stringify(response));
    await sendResponse(response);
    return response.ok ? 0 : exitCodeForProtocolCode(response.code);
  }

  throw Object.assign(new Error(`ledgerd: opcao desconhecida: ${argv.join(' ')}`), { code: 'USAGE' });
}

async function handlePeerRequest({ store, peer, manifest }) {
  let envelope;
  try {
    envelope = parseCanonicalJson(peer.payload);
    if (envelope.protocol !== protocolVersion) {
      throw Object.assign(new Error(`protocolo incompativel: ${envelope.protocol}`), { code: 'INVALID_STATE' });
    }
    const result = await executeCommand({ store, envelope, peer, manifest });
    return {
      ...okResponse({
        command: envelope.command,
        peer: { uid: peer.uid, gid: peer.gid },
        result
      }),
      responseSocket: envelope.responseSocket ?? null
    };
  } catch (error) {
    return {
      ...errorResponse(error),
      command: envelope?.command ?? null,
      responseSocket: envelope?.responseSocket ?? null
    };
  }
}

async function executeCommand({ store, envelope, peer, manifest }) {
  const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
  assertClientManifestIdentity({ envelope, payload, manifest });
  if (envelope.command === 'status') {
    return store.readMissionStatus(payload.missaoId ?? envelope.missaoId);
  }
  if (envelope.command === 'listar') {
    return store.listMissions({
      cursor: payload.cursor ?? payload.afterLedgerSeq ?? 0,
      limit: payload.limit ?? 25
    });
  }
  if (envelope.command === 'audit') {
    return {
      ok: true,
      audit: 'stub',
      message: 'audit local ainda nao implementado neste passo',
      codeManifestHash: manifest.codeManifestHash
    };
  }
  return store.append({
    ...envelope,
    missaoId: payload.missaoId ?? envelope.missaoId,
    expectedLedgerSeq: payload.expectedLedgerSeq,
    expectedLedgerHeadHash: payload.expectedLedgerHeadHash,
    payload,
    peerUid: peer.uid,
    actorUid: peer.uid,
    actorGid: peer.gid,
    claimedActorUid: envelope.actorUid ?? envelope.atorUid ?? null,
    codeManifestHash: manifest.codeManifestHash,
    buildId: manifest.buildId
  });
}

function assertClientManifestIdentity({ envelope, payload, manifest }) {
  const clientCodeManifestHash = envelope.codeManifestHash ?? payload.codeManifestHash ?? null;
  if (clientCodeManifestHash != null && clientCodeManifestHash !== manifest.codeManifestHash) {
    throw new InvalidStateError('codeManifestHash do cliente diverge do manifesto verificado pelo ledgerd', {
      clientCodeManifestHash,
      verifiedCodeManifestHash: manifest.codeManifestHash
    });
  }
  const clientBuildId = envelope.buildId ?? payload.buildId ?? null;
  if (clientBuildId != null && clientBuildId !== manifest.buildId) {
    throw new InvalidStateError('buildId do cliente diverge do manifesto verificado pelo ledgerd', {
      clientBuildId,
      verifiedBuildId: manifest.buildId
    });
  }
}

async function sendResponse(response) {
  const socketPath = response?.result?.responseSocket ?? response?.responseSocket;
  if (!socketPath) {
    return;
  }
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.end(canonicalize(response));
    });
    socket.once('close', resolve);
  });
}

function notifyParentReady(socketPath) {
  if (process.send) {
    process.send({ type: 'listening', socketPath });
  }
}

function has(argv, flag) {
  return argv.includes(flag);
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

function helperOptions(argv) {
  return {
    helperPath: valueAfter(argv, '--uid-helper') ?? undefined,
    manifestPath: valueAfter(argv, '--uid-manifest') ?? undefined
  };
}

if (process.argv[1] && resolveCliPath(import.meta.url) === process.argv[1]) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    const response = errorResponse(error);
    console.error(JSON.stringify({
      ok: false,
      code: response.code,
      rawCode: response.rawCode,
      message: response.message,
      details: response.details
    }));
    process.exitCode = error.code === 'USAGE' ? 2 : exitCodeForProtocolCode(response.code);
  });
}

export async function sendLedgerdRequest(socketPath, payload) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.end(`${JSON.stringify(payload)}\n`);
    });
    socket.once('close', resolve);
  });
}

export { describePeerAuth };

function resolveCliPath(moduleUrl) {
  return fileURLToPath(moduleUrl);
}

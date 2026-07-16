#!/usr/bin/env node
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedgerStore } from '../lib/ledger-store.js';
import { protocolVersion } from '../lib/protocol.js';
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
      onListening: () => notifyParentReady(socketPath)
    });
    const claimed = JSON.parse(peer.payload || '{}');
    const result = await store.append({
      ...claimed,
      peerUid: peer.uid,
      actorUid: peer.uid,
      claimedActorUid: claimed.actorUid ?? claimed.atorUid ?? null,
      codeManifestHash: manifest.codeManifestHash
    });
    console.log(JSON.stringify({ ok: true, peer: { uid: peer.uid, gid: peer.gid }, result }));
    return 0;
  }

  throw Object.assign(new Error(`ledgerd: opcao desconhecida: ${argv.join(' ')}`), { code: 'USAGE' });
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
    console.error(JSON.stringify({
      ok: false,
      code: error.code ?? error.name ?? 'ERROR',
      message: error.message,
      details: error.details ?? null
    }));
    process.exitCode = error.code === 'USAGE' ? 2 : 1;
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

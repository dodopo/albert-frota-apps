#!/usr/bin/env node
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acceptAuthenticatedPeer,
  buildUidPeerHelper,
  describePeerAuth
} from '../lib/uid-peer.js';

async function connectAndClaim(socketPath, actor) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.end(`${JSON.stringify(actor)}\n`);
    });
    socket.once('close', resolve);
  });
}

async function runCase(label, socketPath, actor) {
  const result = await acceptAuthenticatedPeer({
    socketPath,
    onListening: () => connectAndClaim(socketPath, actor)
  });
  console.log(`${label}: accepted uid=${result.uid} gid=${result.gid} primitive=${result.primitive}`);
  console.log(`${label}: helper-stderr=${JSON.stringify(result.evidence.stderr)}`);
  return result;
}

async function runSpoofCase(socketPath, actor) {
  try {
    await acceptAuthenticatedPeer({
      socketPath,
      onListening: () => connectAndClaim(socketPath, actor)
    });
    console.log('spoof: unexpectedly accepted');
    return 1;
  } catch (error) {
    console.log(`spoof: rejected code=${error.code} message=${error.message}`);
    if (error.peer) {
      console.log(`spoof: peer uid=${error.peer.uid} gid=${error.peer.gid} claimed uid=${error.actor?.uid} gid=${error.actor?.gid}`);
    }
    return error.code === 'UID_PEER_ACTOR_MISMATCH' ? 0 : 1;
  }
}

const tempDir = await mkdtemp(join(tmpdir(), 'cartorio-uid-peer-'));
try {
  await buildUidPeerHelper({ force: true });
  const info = describePeerAuth();
  console.log(`mode=${info.mode}`);
  console.log(`helper=${info.helperBinary}`);
  console.log(`primitive=${info.primitive}`);

  const realActor = {
    actorUid: process.getuid(),
    actorGid: process.getgid()
  };
  const accepted = await runCase('real', join(tempDir, 'real.sock'), realActor);

  const spoofActor = {
    actorUid: realActor.actorUid + 1,
    actorGid: realActor.actorGid
  };
  const spoofExit = await runSpoofCase(join(tempDir, 'spoof.sock'), spoofActor);

  if (accepted.uid !== realActor.actorUid || accepted.gid !== realActor.actorGid || spoofExit !== 0) {
    process.exitCode = 1;
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

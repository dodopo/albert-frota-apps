import { DaemonUnavailableError } from './protocol.js';

export function createUnavailableError(message) {
  return new DaemonUnavailableError(message);
}

export async function appendLedgerEvent(event) {
  throw createUnavailableError('ledger-store.appendLedgerEvent stub');
}

export async function readLedgerHead() {
  throw createUnavailableError('ledger-store.readLedgerHead stub');
}

export async function createSnapshot() {
  throw createUnavailableError('ledger-store.createSnapshot stub');
}

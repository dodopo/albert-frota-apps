export const KEYRING_VERSION = 'cartorio.keyring.v1';

export async function loadKeyring(path) {
  throw new Error(`keyring.loadKeyring not_implemented: ${path}`);
}

export function deriveKeyIdFromPublicKey(pubRaw) {
  throw new Error('keyring.deriveKeyIdFromPublicKey crypto_not_implemented');
}

export function validateKeyringEntry(entry) {
  if (!entry || entry.alg !== 'ed25519') {
    throw new Error('keyring.invalid_entry');
  }
  return true;
}

export const RECEIPT_VERSION = 'cartorio.receipt.v1';

export function buildReceipt({ missaoId, ledgerHeadHash, ledgerSeq, commit, artefatos = [], runId, ator, ts, keyId, codeManifestHash, buildId } = {}) {
  return {
    version: RECEIPT_VERSION,
    missaoId,
    ledgerHeadHash,
    ledgerSeq,
    commit,
    artefatos,
    runId,
    ator,
    ts,
    keyId,
    codeManifestHash,
    buildId,
    signature: null
  };
}

export async function signReceipt(receipt) {
  throw new Error('receipt.signReceipt crypto_not_implemented');
}

export async function verifyReceipt(receipt) {
  throw new Error('receipt.verifyReceipt crypto_not_implemented');
}

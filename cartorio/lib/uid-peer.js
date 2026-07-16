export function describePeerAuth() {
  return {
    mode: 'stub',
    requiredProductionMode: 'native-accept-with-kernel-peer-credential',
    note: 'Node puro nao e fundamento aceito para UID/GID efetivo no macOS.'
  };
}

export async function acceptAuthenticatedPeer() {
  throw new Error('uid-peer.acceptAuthenticatedPeer native_not_implemented');
}

export function assertPeerMatchesActor() {
  throw new Error('uid-peer.assertPeerMatchesActor native_not_implemented');
}

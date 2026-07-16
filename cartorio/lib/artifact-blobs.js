export async function hashArtifactBlob(path) {
  throw new Error(`artifact-blobs.hashArtifactBlob crypto_not_implemented: ${path}`);
}

export async function collectArtifactBlobs(paths = []) {
  return paths.map((path) => ({
    path,
    blobSha256: null,
    stub: true
  }));
}

export function normalizeArtifactPath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('artifact-blobs.invalid_path');
  }
  return path;
}

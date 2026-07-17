#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatRemoteError, formatRemoteResult, verifyRemoteReceipt } from '../lib/remote-verify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const HELP = `verify-receipt ${packageJson.version}

Uso:
  verify-receipt [--repo <path>] [--commit <sha>] [--app-dir <path>]
                 [--bootstrap-keyring-fingerprint <sha256>] [--bootstrap-base-ref <ref>]
                 [--help] [--version]

Valida o required check remoto do Cartorio usando apenas objetos do commit Git.
Estados: receipt-valid | break-glass-valid | bootstrap-valid | fail`;

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(packageJson.version);
    return 0;
  }

  const result = await verifyRemoteReceipt({
    repo: valueAfter(argv, '--repo') ?? process.cwd(),
    commit: valueAfter(argv, '--commit') ?? 'HEAD',
    appDir: valueAfter(argv, '--app-dir') ?? null,
    expectedBootstrapKeyringFingerprint: valueAfter(argv, '--bootstrap-keyring-fingerprint') ?? undefined,
    bootstrapBaseRef: valueAfter(argv, '--bootstrap-base-ref') ?? undefined
  });
  process.stdout.write(formatRemoteResult(result));
  return 0;
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(formatRemoteError(error));
    process.exitCode = 1;
  });
}

export { main };

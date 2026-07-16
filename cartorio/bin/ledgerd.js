#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocolVersion } from '../lib/protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const HELP = `ledgerd ${packageJson.version}

Uso:
  ledgerd [--help] [--version] [--self-check]

Stub do daemon escritor unico do Cartorio.
Protocolo: ${protocolVersion}

Nao abre UDS real, nao autentica peer, nao grava ledger e nao assina receipts neste passo.`;

function main(argv = process.argv.slice(2)) {
  const [arg] = argv;

  if (!arg || arg === '--help' || arg === '-h') {
    console.log(HELP);
    return 0;
  }

  if (arg === '--version' || arg === '-v') {
    console.log(packageJson.version);
    return 0;
  }

  if (arg === '--self-check') {
    console.log('ledgerd stub: ok');
    return 0;
  }

  console.error(`ledgerd: opcao desconhecida: ${arg}`);
  return 2;
}

process.exitCode = main();

#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocolVersion, SUPPORTED_COMMANDS } from '../lib/protocol.js';
import { createUnavailableError } from '../lib/ledger-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const HELP = `missao ${packageJson.version}

Uso:
  missao <comando> [opcoes]

Comandos:
  abrir      Registra a abertura de uma missao no ledgerd
  entregar   Registra entrega com runId e artefatos declarados
  coletar    Registra coleta/confirmacao de artefatos
  status     Consulta estado local via ledgerd
  audit      Executa auditoria local de receipts, sessions e break-glass

Opcoes:
  --help, -h       Mostra esta ajuda
  --version, -v    Mostra a versao do pacote

Nota:
  Este passo 2 entrega apenas o esqueleto. UDS real, autenticacao de peer,
  ledger persistente, crypto e canonicalizacao real ficam deliberadamente
  fora deste stub.

Protocolo CLI->ledgerd: ${protocolVersion}`;

function printHelp() {
  console.log(HELP);
}

function printVersion() {
  console.log(packageJson.version);
}

function main(argv = process.argv.slice(2)) {
  const [command] = argv;

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  if (command === '--version' || command === '-v') {
    printVersion();
    return 0;
  }

  if (!SUPPORTED_COMMANDS.includes(command)) {
    console.error(`missao: comando desconhecido: ${command}`);
    console.error('Use "missao --help" para ver os comandos disponiveis.');
    return 2;
  }

  const error = createUnavailableError('ledgerd real ainda nao implementado no passo 2');
  console.error(`${error.code}: ${error.message}`);
  return 69;
}

process.exitCode = main();

#!/usr/bin/env node
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, parseCanonicalJson } from '../lib/canonical-json.js';
import { collectArtifactBlobs, normalizeArtifactPath } from '../lib/artifact-blobs.js';
import { auditLocalRepository, formatAuditReport } from '../lib/audit.js';
import { computeTreeHashExcludingReceipts } from '../lib/remote-verify.js';
import {
  DaemonUnavailableError,
  errorResponse,
  exitCodeForProtocolCode,
  makeEnvelope,
  protocolVersion,
  SUPPORTED_COMMANDS
} from '../lib/protocol.js';
import { verifyUidPeerHelperManifest } from '../lib/uid-peer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const DEFAULT_SOCKET = '/Users/cartorio/run/ledgerd.sock';
const RESPONSE_TMP_PARENT = '/tmp';

const HELP = `missao ${packageJson.version}

Uso:
  missao <comando> --missao-id <id> --run-id <run> [opcoes]
  missao audit [--ledger <path> --receipt-dir <dir> --sessions-root <dir> --json]
  missao --self-check [--uid-helper <path> --uid-manifest <path>]

Comandos:
  abrir      Registra a abertura de uma missao no ledgerd
  entregar   Registra entrega com runId e artefatos declarados
  coletar    Registra coleta/confirmacao de artefatos
  status     Consulta estado via ledgerd sem escrever no ledger
  audit      Auditoria local do ledger, receipts e proveniencia

Opcoes:
  --socket <path>             UDS do ledgerd (ou CARTORIO_LEDGERD_SOCKET)
  --ledger <path>             Ledger local para audit (ou CARTORIO_LEDGER_PATH)
  --ledger-state <path>       Head anti-rollback para audit
  --snapshot-dir <path>       Diretorio de snapshots para audit
  --receipt-dir <dir>         Diretorio .cartorio/missoes para audit
  --keyring <path>            Keyring publico para validar receipts
  --private-key <path>        Chave privada local; audit confere permissao se existir
  --sessions-root <dir>       Raiz OpenClaw com <agent>/sessions/sessions.json
  --sessions-json <path>      sessions.json unico, ou template com {agentId}
  --break-glass-dir <dir>     Diretorio .cartorio/break-glass para audit
  --json                      Saida JSON do audit
  --missao-id, --id <id>      Identificador da missao
  --run-id <run>              Proveniencia agent:/human:/manual:
  --idempotency-key <key>     Chave idempotente; default deterministico
  --actor-uid <uid>           UID alegado; ledgerd sempre usa o UID real do peer
  --payload-json <json>       Objeto JSON adicional do payload
  --commit <sha>              Commit Git base da entrega; default HEAD
  --artefato <path[:sha256]>  Pode repetir; sha declarado e conferido contra o blob git
  --expected-ledger-seq <n>   Cabeca esperada para anti-rollback
  --expected-ledger-head-hash <hash>
  --help, -h                 Mostra esta ajuda
  --version, -v              Mostra a versao do pacote

Protocolo CLI->ledgerd: ${protocolVersion}`;

async function main(argv = process.argv.slice(2)) {
  const [command] = argv;

  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }

  if (command === '--version' || command === '-v') {
    console.log(packageJson.version);
    return 0;
  }

  if (command === '--self-check') {
    const manifest = await verifyUidPeerHelperManifest(helperOptions(argv));
    console.log(`missao self-check ok codeManifestHash=${manifest.codeManifestHash}`);
    return 0;
  }

  if (!SUPPORTED_COMMANDS.includes(command)) {
    console.error(`missao: comando desconhecido: ${command}`);
    console.error('Use "missao --help" para ver os comandos disponiveis.');
    return 2;
  }

  const options = parseOptions(argv.slice(1));
  if (command === 'audit') {
    const report = await auditLocalRepository({
      ledgerPath: options.ledgerPath,
      statePath: options.statePath,
      snapshotDir: options.snapshotDir,
      socketPath: options.socket,
      receiptDir: options.receiptDir,
      keyringPath: options.keyringPath,
      privateKeyPath: options.privateKeyPath,
      sessionsRoot: options.sessionsRoot,
      sessionsPath: options.sessionsPath,
      breakGlassDir: options.breakGlassDir
    });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(formatAuditReport(report));
    }
    return report.ok ? 0 : 1;
  }
  const socketPath = options.socket ?? process.env.CARTORIO_LEDGERD_SOCKET ?? DEFAULT_SOCKET;
  const envelope = await buildEnvelope(command, options);
  const response = await requestLedgerd(socketPath, envelope);
  printResponse(response);
  return response.ok ? 0 : exitCodeForProtocolCode(response.code);
}

async function buildEnvelope(command, options) {
  const payload = await buildPayload(command, options);
  const base = makeEnvelope({
    command,
    payload,
    idempotencyKey: options.idempotencyKey,
    actorUid: options.actorUid == null ? process.getuid?.() : Number(options.actorUid),
    actorGid: process.getgid?.(),
    runId: options.runId
  });
  if (!base.runId && command !== 'status' && command !== 'audit') {
    throw Object.assign(new Error('runId obrigatorio para comandos de escrita'), { code: 'INVALID_STATE' });
  }
  if (!base.idempotencyKey && command !== 'status' && command !== 'audit') {
    base.idempotencyKey = defaultIdempotencyKey(base);
  }
  if ((command === 'status' || command === 'audit') && !base.idempotencyKey) {
    base.idempotencyKey = `${command}:${payload.missaoId ?? 'all'}`;
  }
  return base;
}

async function buildPayload(command, options) {
  const payload = { ...(options.payloadJson ?? {}) };
  const missaoId = options.missaoId ?? options.id;
  if (missaoId) {
    payload.missaoId = String(missaoId);
  }
  if (!payload.missaoId && command !== 'audit') {
    throw Object.assign(new Error('missaoId obrigatorio'), { code: 'INVALID_STATE' });
  }
  if (options.artefato.length > 0) {
    payload.artefatos = options.artefato.map(parseArtefato);
  }
  if (command === 'entregar') {
    const resolved = await collectArtifactBlobs(payload.artefatos ?? [], {
      cwd: process.cwd(),
      commit: options.commit
    });
    const tree = await computeTreeHashExcludingReceipts({
      repo: resolved.repoRoot,
      commit: resolved.commit,
      appDir: ''
    });
    payload.commit = resolved.commit;
    payload.parentCommit = resolved.commit;
    payload.treeScope = tree.treeScope;
    payload.treeHashExcludingReceipts = tree.treeHashExcludingReceipts;
    payload.cartorioRepoRoot = resolved.repoRoot;
    payload.artefatos = resolved.artifacts;
  } else if (options.commit) {
    payload.commit = String(options.commit);
  }
  if (options.expectedLedgerSeq != null) {
    payload.expectedLedgerSeq = Number(options.expectedLedgerSeq);
  }
  if (options.expectedLedgerHeadHash != null) {
    payload.expectedLedgerHeadHash = String(options.expectedLedgerHeadHash);
  }
  return payload;
}

async function requestLedgerd(socketPath, envelope) {
  const tempDir = await mkdtemp(join(RESPONSE_TMP_PARENT, 'cartorio-missao-'));
  await chmod(tempDir, 0o711);
  const responseSocket = join(tempDir, `response-${randomBytes(16).toString('hex')}.sock`);
  let server;
  let cancelResponse;
  try {
    const responsePromise = listenForResponse(responseSocket);
    server = responsePromise.server;
    cancelResponse = responsePromise.cancel;
    await responsePromise.ready;
    await chmod(responseSocket, 0o666);
    const request = { ...envelope, responseSocket };
    await sendRequest(socketPath, canonicalize(request));
    const response = await responsePromise.result;
    delete response.responseSocket;
    return response;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'EACCES') {
      return errorResponse(new DaemonUnavailableError('ledgerd indisponivel', {
        socketPath,
        causeCode: error.code
      }));
    }
    return errorResponse(error);
  } finally {
    cancelResponse?.();
    await closeServer(server);
    await rm(tempDir, { recursive: true, force: true });
  }
}

function listenForResponse(socketPath) {
  const server = net.createServer();
  let settle;
  let fail;
  const result = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  const timer = setTimeout(() => {
    fail(new DaemonUnavailableError('ledgerd nao respondeu dentro do prazo'));
    server.close();
  }, 5000);
  server.once('connection', (socket) => {
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.once('end', () => {
      clearTimeout(timer);
      try {
        settle(parseCanonicalJson(data));
      } catch (error) {
        fail(error);
      } finally {
        server.close();
      }
    });
    socket.once('error', fail);
  });
  return {
    server,
    ready,
    result,
    cancel: () => clearTimeout(timer)
  };
}

async function sendRequest(socketPath, canonicalPayload) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.end(canonicalPayload);
    });
    socket.once('close', resolve);
  });
}

function printResponse(response) {
  if (response.ok) {
    console.log(JSON.stringify({
      ok: true,
      command: response.command,
      status: summarizeStatus(response),
      receipt: response.result?.receipt ?? null,
      result: response.result
    }, null, 2));
    return;
  }
  console.error(JSON.stringify(response, null, 2));
}

function summarizeStatus(response) {
  const event = response.result?.event;
  if (event) {
    return {
      missaoId: event.missaoId,
      state: event.stateAfter,
      ledgerSeq: event.seq,
      ledgerHeadHash: event.hash,
      idempotent: Boolean(response.result?.idempotent)
    };
  }
  if (response.result?.state) {
    return {
      missaoId: response.result.missaoId,
      state: response.result.state,
      ledgerSeq: response.result.head?.ledgerSeq,
      ledgerHeadHash: response.result.head?.ledgerHeadHash
    };
  }
  return null;
}

function parseOptions(args) {
  const options = {
    artefato: []
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      index += 1;
      if (index >= args.length) {
        throw Object.assign(new Error(`opcao sem valor: ${arg}`), { code: 'INVALID_STATE' });
      }
      return args[index];
    };
    switch (arg) {
      case '--socket':
      case '--ledgerd-socket':
        options.socket = next();
        break;
      case '--ledger':
        options.ledgerPath = next();
        break;
      case '--ledger-state':
        options.statePath = next();
        break;
      case '--snapshot-dir':
        options.snapshotDir = next();
        break;
      case '--receipt-dir':
        options.receiptDir = next();
        break;
      case '--keyring':
        options.keyringPath = next();
        break;
      case '--private-key':
        options.privateKeyPath = next();
        break;
      case '--sessions-root':
        options.sessionsRoot = next();
        break;
      case '--sessions-json':
        options.sessionsPath = next();
        break;
      case '--break-glass-dir':
        options.breakGlassDir = next();
        break;
      case '--json':
        options.json = true;
        break;
      case '--missao-id':
      case '--id':
        options.missaoId = next();
        break;
      case '--run-id':
        options.runId = next();
        break;
      case '--idempotency-key':
        options.idempotencyKey = next();
        break;
      case '--actor-uid':
      case '--ator-uid':
        options.actorUid = Number(next());
        break;
      case '--payload-json':
        options.payloadJson = JSON.parse(next());
        break;
      case '--commit':
        options.commit = next();
        break;
      case '--artefato':
        options.artefato.push(next());
        break;
      case '--expected-ledger-seq':
        options.expectedLedgerSeq = next();
        break;
      case '--expected-ledger-head-hash':
        options.expectedLedgerHeadHash = next();
        break;
      default:
        if (!options.missaoId && !arg.startsWith('-')) {
          options.missaoId = arg;
          break;
        }
        throw Object.assign(new Error(`opcao desconhecida: ${arg}`), { code: 'INVALID_STATE' });
    }
  }
  if (options.payloadJson != null && (typeof options.payloadJson !== 'object' || Array.isArray(options.payloadJson))) {
    throw Object.assign(new Error('--payload-json precisa ser objeto JSON'), { code: 'INVALID_STATE' });
  }
  return options;
}

function parseArtefato(value) {
  const raw = String(value);
  const separator = raw.lastIndexOf(':');
  const path = separator === -1 ? raw : raw.slice(0, separator);
  const blobSha256 = separator === -1 ? null : raw.slice(separator + 1).toLowerCase();
  const normalizedPath = normalizeArtifactPath(path);
  if (blobSha256 != null && !/^[0-9a-f]{64}$/i.test(blobSha256)) {
    throw Object.assign(new Error('--artefato precisa ser path[:sha256] com sha256 hex'), { code: 'INVALID_STATE' });
  }
  return blobSha256 == null ? { path: normalizedPath } : { path: normalizedPath, blobSha256 };
}

function defaultIdempotencyKey(envelope) {
  const hash = createHash('sha256').update(canonicalize({
    command: envelope.command,
    payload: envelope.payload,
    runId: envelope.runId
  }), 'utf8').digest('hex').slice(0, 16);
  return `missao:${envelope.payload.missaoId}:${envelope.command}:${hash}`;
}

function helperOptions(argv) {
  return {
    helperPath: valueAfter(argv, '--uid-helper') ?? undefined,
    manifestPath: valueAfter(argv, '--uid-manifest') ?? undefined
  };
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return null;
  }
  return argv[index + 1] ?? null;
}

async function closeServer(server) {
  if (!server?.listening) {
    return;
  }
  await new Promise((resolve) => server.close(resolve));
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  const response = errorResponse(error);
  console.error(JSON.stringify(response, null, 2));
  process.exitCode = exitCodeForProtocolCode(response.code);
});

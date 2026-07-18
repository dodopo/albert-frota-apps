export const protocolVersion = 'cartorio-cli-ledgerd/v0.3-uds';

export const SUPPORTED_COMMANDS = ['abrir', 'entregar', 'coletar', 'status', 'listar', 'audit', 'receipt'];

export const EVENT_TYPES = {
  MISSAO_ABERTA: 'missao.aberta',
  ENTREGA_REGISTRADA: 'missao.entregue',
  COLETA_REGISTRADA: 'missao.coletada',
  STATUS_CONSULTADO: 'missao.status_consultado',
  LISTAR_EXECUTADO: 'missao.listar_executado',
  AUDIT_EXECUTADO: 'missao.audit_executado'
};

export class CartorioError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CartorioError';
    this.code = code;
    this.details = details;
  }
}

export class ConflictError extends CartorioError {
  constructor(message = 'conflito de idempotencia ou estado', details = {}) {
    super('CONFLICT', message, details);
    this.name = 'ConflictError';
  }
}

export class PermissionDeniedError extends CartorioError {
  constructor(message = 'permissao negada pelo ledgerd', details = {}) {
    super('PERMISSION_DENIED', message, details);
    this.name = 'PermissionDeniedError';
  }
}

export class UidPeerActorMismatchError extends CartorioError {
  constructor(message = 'UID efetivo do peer diverge do ator alegado', details = {}) {
    super('UID_PEER_ACTOR_MISMATCH', message, details);
    this.name = 'UidPeerActorMismatchError';
  }
}

export class InvalidStateError extends CartorioError {
  constructor(message = 'estado invalido para a transicao solicitada', details = {}) {
    super('INVALID_STATE', message, details);
    this.name = 'InvalidStateError';
  }
}

export class GitContextMissingError extends CartorioError {
  constructor(message = 'contexto git ausente para resolver artefatos', details = {}) {
    super('GIT_CONTEXT_MISSING', message, details);
    this.name = 'GitContextMissingError';
  }
}

export class DaemonUnavailableError extends CartorioError {
  constructor(message = 'ledgerd indisponivel', details = {}) {
    super('DAEMON_UNAVAILABLE', message, details);
    this.name = 'DaemonUnavailableError';
  }
}

export function makeEnvelope({ command, payload = {}, idempotencyKey, actorUid, actorGid, runId, responseSocket } = {}) {
  if (!SUPPORTED_COMMANDS.includes(command)) {
    throw new InvalidStateError(`comando fora do protocolo: ${command}`);
  }

  const envelope = compactEnvelope({
    protocol: protocolVersion,
    command,
    idempotencyKey,
    actorUid,
    actorGid,
    runId,
    payload
  });
  if (responseSocket) {
    envelope.responseSocket = responseSocket;
  }
  return envelope;
}

function compactEnvelope(envelope) {
  return Object.fromEntries(Object.entries(envelope).filter(([, value]) => value !== undefined));
}

export function okResponse({ command, result, peer } = {}) {
  return {
    ok: true,
    protocol: protocolVersion,
    command,
    peer,
    result
  };
}

export function errorResponse(error) {
  return {
    ok: false,
    protocol: protocolVersion,
    code: normalizeErrorCode(error),
    rawCode: error?.code ?? error?.name ?? 'ERROR',
    message: error?.message ?? String(error),
    details: sanitizeDetails(error?.details)
  };
}

export function normalizeErrorCode(error) {
  const code = error?.code ?? error?.name;
  if (code === 'CONFLICT') {
    return 'CONFLICT';
  }
  if (code === 'INVALID_STATE') {
    return 'INVALID_STATE';
  }
  if (code === 'GIT_CONTEXT_MISSING') {
    return 'GIT_CONTEXT_MISSING';
  }
  if (code === 'DAEMON_UNAVAILABLE') {
    return 'DAEMON_UNAVAILABLE';
  }
  if (code === 'UID_PEER_ACTOR_MISMATCH') {
    return 'UID_PEER_ACTOR_MISMATCH';
  }
  if (code === 'EACCES' || code === 'EPERM' || String(code ?? '').startsWith('UID_PEER_')) {
    return 'PERMISSION_DENIED';
  }
  return 'INVALID_STATE';
}

export function exitCodeForProtocolCode(code) {
  return {
    CONFLICT: 73,
    PERMISSION_DENIED: 77,
    INVALID_STATE: 65,
    GIT_CONTEXT_MISSING: 66,
    DAEMON_UNAVAILABLE: 69,
    UID_PEER_ACTOR_MISMATCH: 77
  }[code] ?? 1;
}

function sanitizeDetails(details) {
  if (details == null) {
    return null;
  }
  return JSON.parse(JSON.stringify(details));
}

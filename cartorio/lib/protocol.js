export const protocolVersion = 'cartorio-cli-ledgerd/v0.2-stub';

export const SUPPORTED_COMMANDS = ['abrir', 'entregar', 'coletar', 'status', 'audit'];

export const EVENT_TYPES = {
  MISSAO_ABERTA: 'missao.aberta',
  ENTREGA_REGISTRADA: 'missao.entrega_registrada',
  COLETA_REGISTRADA: 'missao.coleta_registrada',
  STATUS_CONSULTADO: 'missao.status_consultado',
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

export class InvalidStateError extends CartorioError {
  constructor(message = 'estado invalido para a transicao solicitada', details = {}) {
    super('INVALID_STATE', message, details);
    this.name = 'InvalidStateError';
  }
}

export class DaemonUnavailableError extends CartorioError {
  constructor(message = 'ledgerd indisponivel', details = {}) {
    super('DAEMON_UNAVAILABLE', message, details);
    this.name = 'DaemonUnavailableError';
  }
}

export function makeEnvelope({ command, payload = {}, idempotencyKey, actorUid, runId } = {}) {
  if (!SUPPORTED_COMMANDS.includes(command)) {
    throw new InvalidStateError(`comando fora do protocolo: ${command}`);
  }

  return {
    protocol: protocolVersion,
    command,
    idempotencyKey,
    actorUid,
    runId,
    payload
  };
}

import { InvalidStateError } from './protocol.js';

export const STATES = {
  INEXISTENTE: 'inexistente',
  ABERTA: 'aberta',
  DELIVERED_PENDING_GIT: 'delivered-pending-git',
  VERIFICADA: 'verificada'
};

export function nextState(currentState, eventType) {
  const state = currentState ?? STATES.INEXISTENTE;
  const transition = `${state}:${eventType}`;
  const next = {
    [`${STATES.INEXISTENTE}:missao.aberta`]: STATES.ABERTA,
    [`${STATES.ABERTA}:missao.entregue`]: STATES.DELIVERED_PENDING_GIT,
    [`${STATES.DELIVERED_PENDING_GIT}:missao.coletada`]: STATES.VERIFICADA
  }[transition];

  if (!next) {
    throw new InvalidStateError('transicao de missao rejeitada pela maquina de estados', {
      currentState: state,
      eventType,
      allowedFlow: 'abrir -> entregar -> delivered-pending-git -> coletar -> verificada'
    });
  }

  return next;
}

export function assertTransition(currentState, eventType) {
  nextState(currentState, eventType);
  return true;
}

export function eventTypeForCommand(command) {
  const eventType = {
    abrir: 'missao.aberta',
    entregar: 'missao.entregue',
    coletar: 'missao.coletada'
  }[command];

  if (!eventType) {
    throw new InvalidStateError(`comando sem transicao de ledger: ${command}`);
  }
  return eventType;
}

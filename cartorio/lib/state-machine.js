import { InvalidStateError } from './protocol.js';

export const STATES = {
  NOVA: 'nova',
  ABERTA: 'aberta',
  ENTREGUE: 'entregue',
  COLETADA: 'coletada',
  CANCELADA: 'cancelada'
};

export function nextState(currentState, eventType) {
  throw new InvalidStateError('state-machine.nextState stub', { currentState, eventType });
}

export function assertTransition(currentState, eventType) {
  nextState(currentState, eventType);
  return true;
}

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { canonicalize } from './canonical-json.js';
import { appendFileAtomic, recoverAtomicOrphans, writeFileAtomic } from './atomic-fs.js';
import { defaultKeyringPath, defaultPrivateKeyPath } from './keyring.js';
import { withLock } from './lock.js';
import { ConflictError, DaemonUnavailableError, InvalidStateError } from './protocol.js';
import { buildReceipt, receiptPathForMission, writeSignedReceipt } from './receipt.js';
import { eventTypeForCommand, nextState, STATES } from './state-machine.js';

export const ZERO_HASH = '0'.repeat(64);
export const LEDGER_RECORD_VERSION = 'cartorio.ledger-record/v1';
const MISSAO_ID_MAX_LENGTH = 120;
const MISSAO_ID_ALLOWED = /^[a-z0-9][a-z0-9._-]*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export function createUnavailableError(message) {
  return new DaemonUnavailableError(message);
}

export async function appendLedgerEvent(event, options = {}) {
  return createLedgerStore(options).append(event);
}

export async function readLedgerHead(options = {}) {
  return createLedgerStore(options).readHead();
}

export async function createSnapshot(options = {}) {
  return createLedgerStore(options).createSnapshot();
}

export function createLedgerStore({
  ledgerPath = process.env.CARTORIO_LEDGER_PATH || '/Users/cartorio/ledger/missoes.jsonl',
  statePath = process.env.CARTORIO_LEDGER_STATE_PATH || `${ledgerPath}.head.json`,
  lockPath = process.env.CARTORIO_LEDGER_LOCK_PATH || `${ledgerPath}.lock`,
  snapshotDir = process.env.CARTORIO_LEDGER_SNAPSHOT_DIR || join(dirname(ledgerPath), 'snapshots'),
  codeManifestHash = process.env.CARTORIO_CODE_MANIFEST_HASH || null,
  buildId = process.env.CARTORIO_BUILD_ID || null,
  receiptDir = process.env.CARTORIO_RECEIPT_DIR || null,
  privateKeyPath = process.env.CARTORIO_LEDGERD_KEY_PATH || defaultPrivateKeyPath(),
  keyringPath = process.env.CARTORIO_KEYRING_PATH || defaultKeyringPath()
} = {}) {
  return new LedgerStore({ ledgerPath, statePath, lockPath, snapshotDir, codeManifestHash, buildId, receiptDir, privateKeyPath, keyringPath });
}

export class LedgerStore {
  constructor({ ledgerPath, statePath, lockPath, snapshotDir, codeManifestHash, buildId, receiptDir, privateKeyPath, keyringPath }) {
    this.ledgerPath = ledgerPath;
    this.statePath = statePath;
    this.lockPath = lockPath;
    this.snapshotDir = snapshotDir;
    this.codeManifestHash = codeManifestHash;
    this.buildId = buildId;
    this.receiptDir = receiptDir;
    this.privateKeyPath = privateKeyPath;
    this.keyringPath = keyringPath;
  }

  async recoverOrphans() {
    const dir = dirname(this.ledgerPath);
    return recoverAtomicOrphans(dir, { prefix: basename(this.ledgerPath) });
  }

  async readHead() {
    await this.recoverOrphans();
    const loaded = await this.loadAndValidate();
    return loaded.head;
  }

  async readMissionStatus(missaoId) {
    await this.recoverOrphans();
    const loaded = await this.loadAndValidate();
    const id = validateMissaoId(missaoId);
    return {
      ok: true,
      missaoId: id,
      state: loaded.missions.get(id) ?? STATES.INEXISTENTE,
      head: loaded.head,
      lastEvent: findLastMissionEvent(loaded.records, id)
    };
  }

  async append(input) {
    return withLock(this.lockPath, async () => {
      await this.recoverOrphans();
      const loaded = await this.loadAndValidate();
      assertExpectedHead(input, loaded.head);

      const normalized = normalizeInput(input);
      const idempotent = findIdempotent(loaded.records, normalized);
      if (idempotent?.samePayload) {
        const receipt = await this.receiptForRecord(idempotent.record);
        return {
          ok: true,
          idempotent: true,
          event: idempotent.record,
          receipt
        };
      }
      if (idempotent && !idempotent.samePayload) {
        throw new ConflictError('idempotency key reutilizada com payload diferente', {
          idempotencyKey: normalized.idempotencyKey,
          missaoId: normalized.missaoId,
          existingSeq: idempotent.record.seq
        });
      }

      const currentState = loaded.missions.get(normalized.missaoId) ?? STATES.INEXISTENTE;
      const resultingState = nextState(currentState, normalized.eventType);
      const seq = loaded.head.ledgerSeq + 1;
      const base = {
        version: LEDGER_RECORD_VERSION,
        seq,
        prevHash: loaded.head.ledgerHeadHash,
        eventId: randomUUID(),
        eventType: normalized.eventType,
        missaoId: normalized.missaoId,
        idempotencyKey: normalized.idempotencyKey,
        payloadHash: normalized.payloadHash,
        payload: normalized.payload,
        actorUid: normalized.actorUid,
        actor: `uid:${normalized.actorUid}`,
        claimedActorUid: normalized.claimedActorUid,
        runId: normalized.runId,
        ts: normalized.ts,
        stateBefore: currentState,
        stateAfter: resultingState,
        codeManifestHash: normalized.codeManifestHash ?? this.codeManifestHash,
        buildId: normalized.buildId ?? this.buildId
      };
      const record = { ...base, hash: hashRecord(base) };
      await appendFileAtomic(this.ledgerPath, canonicalize(record), { mode: 0o600 });

      const nextHead = {
        schema: 'cartorio.ledger-head/v1',
        ledgerPath: this.ledgerPath,
        ledgerSeq: record.seq,
        ledgerHeadHash: record.hash,
        updatedAt: new Date().toISOString()
      };
      await writeFileAtomic(this.statePath, `${JSON.stringify(nextHead, null, 2)}\n`, { mode: 0o600 });
      const receipt = await this.emitReceiptIfVerified(record, loaded.records);

      return {
        ok: true,
        idempotent: false,
        event: record,
        receipt
      };
    });
  }

  async createSnapshot() {
    return withLock(this.lockPath, async () => {
      const loaded = await this.loadAndValidate();
      await mkdir(this.snapshotDir, { recursive: true, mode: 0o700 });
      const snapshotPath = join(this.snapshotDir, `ledger-${String(loaded.head.ledgerSeq).padStart(12, '0')}.json`);
      await writeFileAtomic(snapshotPath, `${JSON.stringify({
        schema: 'cartorio.ledger-snapshot/v1',
        head: loaded.head,
        missions: Object.fromEntries(loaded.missions)
      }, null, 2)}\n`, { mode: 0o600 });
      return { snapshotPath, head: loaded.head };
    });
  }

  async loadAndValidate() {
    const records = await readLedgerRecords(this.ledgerPath);
    let expectedSeq = 1;
    let previousHash = ZERO_HASH;
    const missions = new Map();
    const idempotency = new Map();

    for (const record of records) {
      if (record.version !== LEDGER_RECORD_VERSION) {
        throw Object.assign(new Error('ledger record version invalida'), { code: 'LEDGER_BAD_RECORD', record });
      }
      if (record.seq !== expectedSeq) {
        throw Object.assign(new Error('gap de seq detectado no ledger'), {
          code: 'LEDGER_SEQ_GAP',
          expectedSeq,
          actualSeq: record.seq
        });
      }
      if (record.prevHash !== previousHash) {
        throw Object.assign(new Error('hash encadeado divergente no ledger'), {
          code: 'LEDGER_CHAIN_BROKEN',
          seq: record.seq,
          expectedPrevHash: previousHash,
          actualPrevHash: record.prevHash
        });
      }
      const computed = hashRecord(stripHash(record));
      if (record.hash !== computed) {
        throw Object.assign(new Error('hash de linha divergente no ledger'), {
          code: 'LEDGER_HASH_MISMATCH',
          seq: record.seq,
          expectedHash: computed,
          actualHash: record.hash
        });
      }
      const before = missions.get(record.missaoId) ?? STATES.INEXISTENTE;
      const after = nextState(before, record.eventType);
      if (record.stateBefore !== before || record.stateAfter !== after) {
        throw Object.assign(new InvalidStateError('estado persistido diverge da maquina de estados', {
          seq: record.seq,
          expectedBefore: before,
          expectedAfter: after,
          actualBefore: record.stateBefore,
          actualAfter: record.stateAfter
        }), { code: 'LEDGER_STATE_MISMATCH' });
      }
      const idemKey = idempotencyKey(record.missaoId, record.idempotencyKey);
      if (idempotency.has(idemKey)) {
        throw new ConflictError('idempotency key duplicada no ledger', { seq: record.seq, idempotencyKey: record.idempotencyKey });
      }
      idempotency.set(idemKey, record);
      missions.set(record.missaoId, after);
      previousHash = record.hash;
      expectedSeq += 1;
    }

    const head = {
      ledgerSeq: records.length,
      ledgerHeadHash: previousHash
    };
    await assertHeadState(this.statePath, head);
    return { records, missions, head };
  }

  async receiptForRecord(record) {
    if (record.stateAfter !== STATES.VERIFICADA) {
      return makeUnsignedReceipt(record);
    }
    const receiptDir = receiptDirForRecord(this.receiptDir, record);
    if (!receiptDir) {
      return makeUnsignedReceipt(record);
    }
    try {
      const text = await readFile(receiptPathForMission(receiptDir, record.missaoId), 'utf8');
      return JSON.parse(text);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return makeUnsignedReceipt(record);
    }
  }

  async emitReceiptIfVerified(record, previousRecords) {
    if (record.stateAfter !== STATES.VERIFICADA) {
      return makeUnsignedReceipt(record);
    }
    const delivery = findLastMissionEventByType(previousRecords, record.missaoId, 'missao.entregue');
    const deliveryPayload = delivery?.payload ?? {};
    const receiptDir = receiptDirForRecord(this.receiptDir, delivery ?? record);
    if (!receiptDir) {
      return makeUnsignedReceipt(record);
    }
    const receipt = buildReceipt({
      missaoId: record.missaoId,
      ledgerHeadHash: record.hash,
      ledgerSeq: record.seq,
      commit: deliveryPayload.commit ?? record.payload?.commit,
      artefatos: deliveryPayload.artefatos ?? record.payload?.artefatos ?? [],
      runId: record.runId,
      ator: record.actor,
      ts: record.ts,
      codeManifestHash: record.codeManifestHash,
      buildId: record.buildId
    });
    return writeSignedReceipt(receipt, receiptPathForMission(receiptDir, record.missaoId), {
      privateKeyPath: this.privateKeyPath,
      keyringPath: this.keyringPath
    });
  }
}

async function readLedgerRecords(ledgerPath) {
  if (!existsSync(ledgerPath)) {
    return [];
  }
  let text;
  try {
    text = await readFile(ledgerPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  if (text.length === 0) {
    return [];
  }
  if (!text.endsWith('\n')) {
    throw Object.assign(new Error('ledger truncado: JSONL nao termina em LF'), {
      code: 'LEDGER_TRUNCATED',
      ledgerPath
    });
  }
  const lines = text.split('\n').filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw Object.assign(new Error('JSONL ruim detectado no ledger'), {
        code: 'LEDGER_BAD_JSON',
        line: index + 1,
        cause: error
      });
    }
  });
}

async function assertHeadState(statePath, actualHead) {
  if (!existsSync(statePath)) {
    if (actualHead.ledgerSeq === 0 && actualHead.ledgerHeadHash === ZERO_HASH) {
      return;
    }
    throw Object.assign(new Error('estado anti-rollback ausente para ledger nao-vazio'), {
      code: 'LEDGER_HEAD_MISSING',
      actualHead
    });
  }

  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    throw Object.assign(new Error('estado anti-rollback invalido'), {
      code: 'LEDGER_HEAD_INVALID',
      statePath,
      cause: error
    });
  }
  if (state.ledgerSeq !== actualHead.ledgerSeq || state.ledgerHeadHash !== actualHead.ledgerHeadHash) {
    const code = state.ledgerSeq > actualHead.ledgerSeq ? 'LEDGER_TRUNCATED' : 'LEDGER_ROLLBACK_DETECTED';
    throw Object.assign(new Error('anti-rollback rejeitou cabeca antiga/divergente'), {
      code,
      stateHead: {
        ledgerSeq: state.ledgerSeq,
        ledgerHeadHash: state.ledgerHeadHash
      },
      actualHead
    });
  }
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidStateError('payload de ledger precisa ser objeto');
  }
  const command = input.command;
  const eventType = input.eventType ?? eventTypeForCommand(command);
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
  const missaoId = validateMissaoId(input.missaoId ?? payload.missaoId);
  const idempotencyKeyValue = String(input.idempotencyKey ?? '');
  if (!idempotencyKeyValue) {
    throw new InvalidStateError('idempotencyKey obrigatoria');
  }
  const actorUid = Number(input.peerUid ?? input.actorUid ?? input.atorUid);
  if (!Number.isInteger(actorUid) || actorUid < 0) {
    throw new InvalidStateError('actorUid real obrigatorio');
  }
  const runId = String(input.runId ?? '');
  if (!runId) {
    throw new InvalidStateError('runId obrigatorio');
  }
  const ts = String(input.ts ?? new Date().toISOString());
  const material = {
    command,
    eventType,
    missaoId,
    payload,
    runId,
    actorUid
  };
  return {
    command,
    eventType,
    missaoId,
    idempotencyKey: idempotencyKeyValue,
    payload,
    payloadHash: sha256(canonicalize(material)),
    actorUid,
    claimedActorUid: input.claimedActorUid ?? input.actorUid ?? input.atorUid ?? null,
    runId,
    ts,
    codeManifestHash: input.codeManifestHash ?? null,
    buildId: input.buildId ?? null
  };
}

function assertExpectedHead(input, head) {
  if (input.expectedLedgerSeq != null && Number(input.expectedLedgerSeq) !== head.ledgerSeq) {
    throw new ConflictError('ledgerSeq esperado diverge da cabeca atual', {
      expectedLedgerSeq: Number(input.expectedLedgerSeq),
      actualLedgerSeq: head.ledgerSeq
    });
  }
  if (input.expectedLedgerHeadHash != null && String(input.expectedLedgerHeadHash) !== head.ledgerHeadHash) {
    throw new ConflictError('ledgerHeadHash esperado diverge da cabeca atual', {
      expectedLedgerHeadHash: String(input.expectedLedgerHeadHash),
      actualLedgerHeadHash: head.ledgerHeadHash
    });
  }
}

function findIdempotent(records, input) {
  const record = records.find((candidate) => candidate.missaoId === input.missaoId && candidate.idempotencyKey === input.idempotencyKey);
  if (!record) {
    return null;
  }
  return {
    record,
    samePayload: record.payloadHash === input.payloadHash
  };
}

function findLastMissionEvent(records, missaoId) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].missaoId === missaoId) {
      return records[index];
    }
  }
  return null;
}

function findLastMissionEventByType(records, missaoId, eventType) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].missaoId === missaoId && records[index].eventType === eventType) {
      return records[index];
    }
  }
  return null;
}

function receiptDirForRecord(configuredReceiptDir, record) {
  if (configuredReceiptDir) {
    return configuredReceiptDir;
  }
  const repoRoot = record?.payload?.cartorioRepoRoot;
  return repoRoot ? join(repoRoot, '.cartorio', 'missoes') : null;
}

function makeUnsignedReceipt(record) {
  return {
    version: 'cartorio.ledger-receipt.unsigned/v1',
    eventId: record.eventId,
    missaoId: record.missaoId,
    ledgerSeq: record.seq,
    ledgerHeadHash: record.hash,
    runId: record.runId,
    ator: record.actor,
    actorUid: record.actorUid,
    codeManifestHash: record.codeManifestHash,
    buildId: record.buildId,
    signature: null
  };
}

function hashRecord(recordWithoutHash) {
  return sha256(canonicalize(recordWithoutHash));
}

function stripHash(record) {
  const stripped = { ...record };
  delete stripped.hash;
  return stripped;
}

function idempotencyKey(missaoId, key) {
  return `${missaoId}\u0000${key}`;
}

export function validateMissaoId(value) {
  if (typeof value !== 'string') {
    throw new InvalidStateError('missaoId obrigatorio');
  }
  if (value.length === 0 || value.length > MISSAO_ID_MAX_LENGTH) {
    throw new InvalidStateError('missaoId com tamanho invalido', {
      maxLength: MISSAO_ID_MAX_LENGTH,
      actualLength: value.length
    });
  }
  if (value !== value.normalize('NFC') || CONTROL.test(value)) {
    throw new InvalidStateError('missaoId contem controle ou Unicode nao canonico', { missaoId: value });
  }
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new InvalidStateError('missaoId rejeitado por risco de path injection', { missaoId: value });
  }
  if (value !== value.toLowerCase()) {
    throw new InvalidStateError('missaoId precisa ser ASCII minusculo para evitar colisao de case', { missaoId: value });
  }
  if (!MISSAO_ID_ALLOWED.test(value)) {
    throw new InvalidStateError('missaoId fora do conjunto ASCII permitido', { missaoId: value });
  }
  return value;
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

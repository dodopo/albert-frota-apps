import { CANONICAL_JSON_VERSION, canonicalize, computeLineHash } from './canonical-json.js';
import { posix as pathPosix } from 'node:path';

export const EVENT_FORMAT_VERSION = 'cartorio.event-schema/v1';

export class SchemaError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SchemaError';
    this.code = 'SCHEMA_ERROR';
    this.details = details;
  }
}

const BASE_FIELDS = ['eventType', 'formatVersion', 'missaoId', 'runId', 'ator', 'ts'];

const EVENT_SCHEMAS = {
  'missao.aberta': {
    required: [...BASE_FIELDS, 'idempotencyKey', 'payload'],
    optional: ['lineHash'],
    payload: {
      required: ['assunto', 'descricao'],
      optional: []
    }
  },
  'missao.entregue': {
    required: [...BASE_FIELDS, 'idempotencyKey', 'commit', 'artefatos', 'payload'],
    optional: ['lineHash'],
    payload: {
      required: ['observacao'],
      optional: []
    }
  },
  'missao.coletada': {
    required: [...BASE_FIELDS, 'idempotencyKey', 'artefatos', 'payload'],
    optional: ['lineHash'],
    payload: {
      required: ['confirmacao'],
      optional: []
    }
  },
  'missao.status': {
    required: [...BASE_FIELDS, 'payload'],
    optional: ['lineHash'],
    payload: {
      required: ['escopo'],
      optional: []
    }
  },
  'missao.audit': {
    required: [...BASE_FIELDS, 'payload'],
    optional: ['lineHash'],
    payload: {
      required: ['resumo'],
      optional: ['problemas']
    }
  }
};

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(object, allowedKeys, context) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new SchemaError('unexpected field in closed schema', {
        context,
        field: key
      });
    }
  }
}

function assertRequiredKeys(object, requiredKeys, context) {
  for (const key of requiredKeys) {
    if (!(key in object)) {
      throw new SchemaError('missing required field', {
        context,
        field: key
      });
    }
  }
}

export function normalizeRepoPath(inputPath, context = 'path') {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    throw new SchemaError('artifact path must be a non-empty string', {
      context,
      valueType: typeof inputPath
    });
  }

  if (inputPath.includes('\\')) {
    throw new SchemaError('backslash paths are not allowed', {
      context,
      path: inputPath
    });
  }

  const normalized = inputPath.normalize('NFC');
  if (pathPosix.isAbsolute(normalized)) {
    throw new SchemaError('absolute paths are not allowed', {
      context,
      path: inputPath
    });
  }

  const collapsed = pathPosix.normalize(normalized);
  if (collapsed === '.' || collapsed === '..' || collapsed.startsWith('../') || collapsed.includes('/../')) {
    throw new SchemaError('path traversal is not allowed', {
      context,
      path: inputPath
    });
  }

  return collapsed;
}

function normalizeArtifact(artifact, context) {
  if (!isPlainObject(artifact)) {
    throw new SchemaError('artifact must be a plain object', {
      context,
      valueType: Object.prototype.toString.call(artifact)
    });
  }

  assertExactKeys(artifact, ['path', 'blobSha256'], context);
  assertRequiredKeys(artifact, ['path', 'blobSha256'], context);

  if (typeof artifact.blobSha256 !== 'string' || artifact.blobSha256.length === 0) {
    throw new SchemaError('blobSha256 must be a non-empty string', {
      context,
      field: 'blobSha256'
    });
  }

  return {
    path: normalizeRepoPath(artifact.path, `${context}.path`),
    blobSha256: artifact.blobSha256.normalize('NFC')
  };
}

function normalizePayload(payload, schema, context) {
  if (!isPlainObject(payload)) {
    throw new SchemaError('payload must be a plain object', {
      context,
      valueType: Object.prototype.toString.call(payload)
    });
  }

  assertExactKeys(payload, [...schema.required, ...schema.optional], context);
  assertRequiredKeys(payload, schema.required, context);

  const normalized = {};
  for (const key of schema.required) {
    const value = payload[key];
    if (key === 'artefatos') {
      if (!Array.isArray(value)) {
        throw new SchemaError('artefatos must be an array', {
          context,
          field: key
        });
      }
      normalized[key] = value.map((artifact, index) => normalizeArtifact(artifact, `${context}.${key}[${index}]`));
      continue;
    }

    if (typeof value !== 'string') {
      throw new SchemaError('required payload fields must be strings', {
        context,
        field: key,
        valueType: typeof value
      });
    }
    normalized[key] = value.normalize('NFC');
  }

  for (const key of schema.optional) {
    if (key in payload) {
      const value = payload[key];
      if (Array.isArray(value)) {
        normalized[key] = value.map((entry, index) => {
          if (typeof entry !== 'string') {
            throw new SchemaError('optional array payload fields must contain strings', {
              context,
              field: key,
              index
            });
          }
          return entry.normalize('NFC');
        });
        continue;
      }
      if (typeof value !== 'string') {
        throw new SchemaError('optional payload fields must be strings', {
          context,
          field: key,
          valueType: typeof value
        });
      }
      normalized[key] = value.normalize('NFC');
    }
  }

  return normalized;
}

export function validateEventRecord(event) {
  if (!isPlainObject(event)) {
    throw new SchemaError('event record must be a plain object', {
      valueType: Object.prototype.toString.call(event)
    });
  }

  const eventType = event.eventType;
  if (typeof eventType !== 'string' || !(eventType in EVENT_SCHEMAS)) {
    throw new SchemaError('unsupported event type', {
      eventType
    });
  }

  const schema = EVENT_SCHEMAS[eventType];
  assertExactKeys(event, [...schema.required, ...schema.optional], 'event');
  assertRequiredKeys(event, schema.required, 'event');

  if (event.formatVersion !== EVENT_FORMAT_VERSION) {
    throw new SchemaError('unexpected event format version', {
      formatVersion: event.formatVersion
    });
  }

  const normalized = {
    eventType,
    formatVersion: EVENT_FORMAT_VERSION,
    missaoId: String(event.missaoId).normalize('NFC'),
    runId: String(event.runId).normalize('NFC'),
    ator: String(event.ator).normalize('NFC'),
    ts: String(event.ts).normalize('NFC')
  };

  if ('idempotencyKey' in event) {
    normalized.idempotencyKey = String(event.idempotencyKey).normalize('NFC');
  }

  if ('commit' in event) {
    normalized.commit = String(event.commit).normalize('NFC');
  }

  if ('artefatos' in event) {
    if (!Array.isArray(event.artefatos)) {
      throw new SchemaError('artefatos must be an array', {
        eventType
      });
    }
    normalized.artefatos = event.artefatos.map((artifact, index) => normalizeArtifact(artifact, `event.artefatos[${index}]`));
  }

  normalized.payload = normalizePayload(event.payload, schema.payload, 'event.payload');

  if ('lineHash' in event) {
    normalized.lineHash = String(event.lineHash).normalize('NFC');
  }

  return normalized;
}

export function finalizeEventRecord(event) {
  const validated = validateEventRecord(event);
  const withHash = {
    ...validated,
    lineHash: computeLineHash(validated)
  };
  return withHash;
}

export function canonicalizeEventRecord(event) {
  return canonicalize(validateEventRecord(event));
}

export function canonicalizeFinalEventRecord(event) {
  return canonicalize(finalizeEventRecord(event));
}

export { CANONICAL_JSON_VERSION };

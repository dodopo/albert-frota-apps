import { createHash } from 'node:crypto';

export const CANONICAL_JSON_VERSION = 'cartorio.canonical-json/v1';
export const CANONICAL_NEWLINE = '\n';
export const CANONICAL_JSON_NEWLINE = CANONICAL_NEWLINE;

export class CanonicalJsonError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CanonicalJsonError';
    this.code = 'CANONICAL_JSON_ERROR';
    this.details = details;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeString(value) {
  return value.normalize('NFC');
}

function canonicalizeScalar(value, context) {
  if (value === null || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return normalizeString(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError('non-finite number is not canonicalizable', {
        context,
        value
      });
    }
    return value;
  }

  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') {
    throw new CanonicalJsonError('unsupported scalar type in canonical json', {
      context,
      type: typeof value
    });
  }

  return undefined;
}

function canonicalizeValue(value, context = '$') {
  const scalar = canonicalizeScalar(value, context);
  if (scalar !== undefined) {
    return scalar;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalizeValue(item, `${context}[${index}]`));
  }

  if (!isPlainObject(value)) {
    throw new CanonicalJsonError('only plain objects and arrays are canonicalizable', {
      context,
      valueType: Object.prototype.toString.call(value)
    });
  }

  const seen = new Set();
  const entries = Object.keys(value).map((originalKey) => {
    const key = normalizeString(String(originalKey));
    if (seen.has(key)) {
      throw new CanonicalJsonError('duplicate key after unicode normalization', {
        context,
        key
      });
    }
    seen.add(key);
    return [key, canonicalizeValue(value[originalKey], `${context}.${key}`)];
  });

  entries.sort(([left], [right]) => compareCodePoints(left, right));

  return Object.fromEntries(entries);
}

export function canonicalize(value) {
  return `${JSON.stringify(canonicalizeValue(value))}${CANONICAL_NEWLINE}`;
}

export function canonicalJson(value) {
  return canonicalize(value);
}

export function canonicalizeToBytes(value) {
  return Buffer.from(canonicalize(value), 'utf8');
}

export function canonicalJsonBytes(value) {
  return canonicalizeToBytes(value);
}

export function parseCanonicalJson(text) {
  if (typeof text !== 'string') {
    throw new CanonicalJsonError('canonical json input must be a string', {
      type: typeof text
    });
  }

  if (!text.endsWith(CANONICAL_NEWLINE) || text.endsWith('\n\n') || text.includes('\r')) {
    throw new CanonicalJsonError('canonical json must end with exactly one LF and contain no CR');
  }

  return JSON.parse(text.slice(0, -1));
}

export function assertCanonicalJson(text) {
  const parsed = parseCanonicalJson(text);
  if (canonicalize(parsed) !== text) {
    throw new CanonicalJsonError('json is not in canonical form');
  }
  return true;
}

export function stripTopLevelLineHash(record) {
  if (!isPlainObject(record)) {
    throw new CanonicalJsonError('line hash input must be a plain object', {
      valueType: Object.prototype.toString.call(record)
    });
  }

  const clone = { ...record };
  delete clone.lineHash;
  return clone;
}

export function computeLineHash(record) {
  const material = canonicalize(stripTopLevelLineHash(record));
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

function compareCodePoints(left, right) {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const diff = leftPoints[index].codePointAt(0) - rightPoints[index].codePointAt(0);
    if (diff !== 0) {
      return diff;
    }
  }
  return leftPoints.length - rightPoints.length;
}

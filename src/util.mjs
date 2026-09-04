import { createHash, randomUUID } from 'node:crypto';

export class RuntimeFault extends Error {
  constructor(code, message = code) { super(message); this.name = 'RuntimeFault'; this.code = code; }
}
export function check(condition, code, message) { if (!condition) throw new RuntimeFault(code, message); }
export const id = () => randomUUID();
export const hash = value => createHash('sha256').update(value).digest('hex');
export function stable(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { check(Number.isFinite(value), 'NON_FINITE'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  check(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), 'NON_JSON');
  return `{${Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}
export const digest = value => hash(stable(value));
export function boundedText(value, max = 8000) {
  check(typeof value === 'string' && value.trim().length > 0, 'EMPTY_TEXT');
  check(Buffer.byteLength(value) <= max, 'TEXT_TOO_LARGE');
  return value;
}
export function rejectObviousSecrets(value) {
  const text = typeof value === 'string' ? value : stable(value);
  // A hygiene check, not a DLP guarantee. Operator review remains mandatory.
  check(!/(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b|\bBearer\s+[A-Za-z0-9._~+\/-]{12,})/i.test(text), 'POSSIBLE_SECRET');
}
export function withDeadline(signal, milliseconds) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds);
}

export async function abortable(fn, signal) {
  signal?.throwIfAborted();
  let onAbort;
  const cancellation = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('ABORTED'));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(fn), cancellation]); }
  finally { signal?.removeEventListener('abort', onAbort); }
}

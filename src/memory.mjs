import { check, digest, withDeadline, abortable } from './util.mjs';
import { verifyEvidence } from './evidence.mjs';

// Transport is deliberately injected. Reuse the connected clab-mem / OMP MCP transport;
// this package neither guesses private HTTP endpoints nor adds a second MCP client.
export class CanonicalMemoryPort {
  constructor({ capabilities, write, lookup, validate }) {
    check(capabilities?.idempotency === 'server-enforced', 'REMOTE_IDEMPOTENCY_REQUIRED');
    check(capabilities?.durableAck === true, 'DURABLE_ACK_REQUIRED');
    check(typeof write === 'function' && typeof lookup === 'function' && typeof validate === 'function', 'MEMORY_CONTRACT_REQUIRED');
    this.write = write; this.lookup = lookup; this.validate = validate;
    this.capabilities = Object.freeze({ ...capabilities });
  }
}
function evidenceIsCurrent(store, workspace, root, ids) {
  store.assertEvidence(workspace, ids);
  for (const evidenceId of ids) {
    const row = store.db.prepare('SELECT record FROM evidence WHERE id=?').get(evidenceId);
    check(verifyEvidence(root, JSON.parse(row.record)), 'STALE_MEMORY_EVIDENCE');
  }
}
export async function publishCandidate(store, lease, root, candidateId, port, { signal, timeoutMs = 15000 } = {}) {
  check(port instanceof CanonicalMemoryPort, 'MEMORY_PORT_UNBOUND');
  const row = store.outbox(candidateId);
  check(row?.workspace === lease.workspace && row.state === 'approved', 'MEMORY_NOT_APPROVED');
  const payload = JSON.parse(row.payload);
  evidenceIsCurrent(store, lease.workspace, root, payload.evidenceIds);
  check(digest(payload) === row.payload_hash && port.validate(payload) === true && digest(payload) === row.payload_hash, 'MEMORY_SCHEMA_MISMATCH');
  store.setOutbox(lease, candidateId, 'approved', 'sending');
  try {
    const deadline = withDeadline(signal, timeoutMs);
    const receipt = await abortable(() => port.write({ idempotencyKey: candidateId, payloadHash: row.payload_hash, payload }, deadline), deadline);
    check(receipt?.idempotencyKey === candidateId && receipt?.payloadHash === row.payload_hash && receipt?.durable === true && typeof receipt?.remoteId === 'string' && receipt.remoteId.length > 0, 'INVALID_MEMORY_ACK');
    store.setOutbox(lease, candidateId, 'sending', 'acked', receipt.remoteId);
    return receipt;
  } catch (error) {
    // An HTTP timeout is not proof that the server did not commit. Never blind-retry.
    try { store.setOutbox(lease, candidateId, 'sending', 'unknown'); } catch { /* lease loss is recovered by next acquire */ }
    throw error;
  }
}
export async function reconcileMemory(store, lease, candidateId, port, { signal, timeoutMs = 15000 } = {}) {
  check(port instanceof CanonicalMemoryPort, 'MEMORY_PORT_UNBOUND');
  const row = store.outbox(candidateId);
  check(row?.workspace === lease.workspace && row.state === 'unknown', 'OUTBOX_STATE_CONFLICT');
  const deadline = withDeadline(signal, timeoutMs);
  const receipt = await abortable(() => port.lookup(candidateId, deadline), deadline);
  if (!receipt) return { state: 'unknown', retryAllowed: false };
  check(receipt.idempotencyKey === candidateId && receipt.payloadHash === row.payload_hash && receipt.durable === true && typeof receipt.remoteId === 'string' && receipt.remoteId.length > 0, 'INVALID_MEMORY_ACK');
  store.setOutbox(lease, candidateId, 'unknown', 'acked', receipt.remoteId);
  return { state: 'acked', remoteId: receipt.remoteId };
}

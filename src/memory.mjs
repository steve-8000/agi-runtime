import { createPublicKey, verify } from 'node:crypto';
import { check, stable } from './util.mjs';
import { verifyEvidence } from './evidence.mjs';

// The model is the only transport to canonical memory: this process cannot call an MCP tool
// (ctx.invokeTool delegates to a same-named built-in only) and, on this host, cannot even open a
// TCP connection to mem.clab.one. What this module owns is verification: a receipt the clab-mem
// server signed is the one piece of tool output that may move journal state. Everything else a
// tool returns is telemetry.

const RECEIPT_PREFIX = 'receipt ';
const TOKEN = /^([a-z_]+)=(\S+)$/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const OUTCOMES = ['committed', 'not_sent'];

/** First line of a tool result if it is a receipt: `receipt outcome=… key=… sig=…`. Unverified until `verifyReceipt`. */
export function parseReceipt(result) {
  const text = result?.content?.find(part => part?.type === 'text')?.text;
  if (typeof text !== 'string') return undefined;
  const line = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  if (!line.startsWith(RECEIPT_PREFIX) || line.length > 2048) return undefined;
  const fields = {};
  for (const token of line.slice(RECEIPT_PREFIX.length).split(' ')) {
    const m = TOKEN.exec(token);
    if (!m || m[1] in fields) return undefined;
    fields[m[1]] = m[2];
  }
  if (!OUTCOMES.includes(fields.outcome) || typeof fields.sig !== 'string') return undefined;
  const cut = line.lastIndexOf(' sig=');
  return { fields, message: line.slice(0, cut), signature: fields.sig };
}

/** Ed25519 over the receipt line without its signature. The public key is operator config; a mismatch is telemetry, never a transition. */
export function verifyReceipt(receipt, publicKeyHex) {
  if (!receipt || !publicKeyHex) return false;
  try {
    const key = createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKeyHex, 'hex').toString('base64url') } });
    return verify(null, Buffer.from(receipt.message, 'utf8'), key, Buffer.from(receipt.signature, 'base64url'));
  } catch { return false; }
}

export function evidenceIsCurrent(store, workspace, root, ids) {
  store.assertEvidence(workspace, ids);
  for (const evidenceId of ids) {
    const row = store.evidence(evidenceId);
    check(row && verifyEvidence(root, row.record), 'STALE_EVIDENCE');
  }
}
/** Evidence receipts a memory write cites anywhere in its input. A citation of a changed file is refused before it is sent. */
export function citedEvidence(store, workspace, input) {
  const ids = new Set();
  for (const candidate of stable(input ?? null).match(UUID) ?? []) if (store.evidence(candidate)?.workspace === workspace) ids.add(candidate);
  return [...ids];
}

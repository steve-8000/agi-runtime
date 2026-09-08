// Read-only observation of OMP's Sharpshooter decision bank.
// The backend writes architecture/product/style itself and injects them into the system
// prompt; consolidated content is therefore never repeated here. Only two facts change the
// next action: deltas captured in this session that are not consolidated yet (invisible
// after compaction) and a consolidation that is failing (decisions silently not persisted).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clipBytes } from './contracts.mjs';

export const BACKEND = 'sharpshooter';
export const MAX_PENDING = 5;
// Bounded scan: a bank with a large backlog must not turn a projection into a directory walk.
const MAX_DELTA_FILES = 120;
const STATEMENT_BYTES = 200;
const NAME = /^[A-Za-z0-9_-]+$/;
// The backend stores `String(error)` from a provider or filesystem call, so the message may
// carry a URL, credential or query parameter. Same rule as kernel.degrade(): never echo it.
// Every branch returns a literal from this table, so nothing from the message reaches output.
const ERROR_KINDS = [
  [/replace_memory_files/, 'malformed-model-response'],
  [/\bmodel error\b/i, 'model-call-failed'],
  [/\b(?:ENOENT|EACCES|EPERM|EIO|ENOSPC|EROFS|EMFILE)\b/, 'bank-io-failed'],
];
export function classifyConsolidationError(message) {
  if (typeof message !== 'string' || !message) return undefined;
  for (const [pattern, kind] of ERROR_KINDS) if (pattern.test(message)) return kind;
  return 'unspecified';
}

/** Bank directory for a workspace. `scope` is the backend's own bank id, never a guessed slug. */
export function bankPath(agentDir, scope) {
  if (typeof agentDir !== 'string' || !agentDir) return undefined;
  if (typeof scope !== 'string' || !NAME.test(scope)) return undefined;
  return join(agentDir, 'memories', BACKEND, scope);
}

const entries = dir => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

/**
 * Pending deltas plus the last consolidation error. Never throws: an unreadable bank is
 * reported as no observation rather than as an empty one, so nothing false is projected.
 */
export function readBank(bank, session) {
  if (!bank) return null;
  try { if (!statSync(bank).isDirectory()) return null; } catch { return null; }
  let state = null;
  try { state = JSON.parse(readFileSync(join(bank, 'state.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') return null; }
  if (state !== null && (typeof state !== 'object' || state.v !== 1)) return null;
  const queue = join(bank, 'queue');
  const dirs = entries(queue).filter(d => d.isDirectory() && NAME.test(d.name)).map(d => d.name);
  // The session that is losing context first; its decisions are the ones missing from history.
  dirs.sort((a, b) => (a === session ? -1 : b === session ? 1 : a.localeCompare(b)));
  const pending = [];
  let total = 0, scanned = 0;
  for (const dir of dirs) {
    // File names are `<ts base36>-<rand>.json`, so a lexical sort is chronological.
    const files = entries(join(queue, dir)).filter(f => f.isFile() && f.name.endsWith('.json')).map(f => f.name).sort();
    total += files.length;
    for (const file of files) {
      if (scanned >= MAX_DELTA_FILES) break;
      scanned++;
      if (pending.length >= MAX_PENDING) continue;
      let delta;
      try { delta = JSON.parse(readFileSync(join(queue, dir, file), 'utf8')); } catch { continue; }
      if (!delta || delta.v !== 1 || typeof delta.statement !== 'string' || !delta.statement) continue;
      pending.push({ kind: String(delta.kind ?? 'decision'), statement: clipBytes(delta.statement, STATEMENT_BYTES) });
    }
  }
  const last = state?.lastError;
  const kind = classifyConsolidationError(last?.message);
  return {
    bank,
    pending,
    pendingTotal: total,
    truncated: total > scanned,
    error: kind ? { at: Number(last.at) || 0, kind, detail: '/memory diagnose' } : null,
    consolidatedAt: Number(state?.lastConsolidatedAt) || 0,
  };
}

/** Resolve the live bank through OMP's backend-agnostic memory runtime. */
export async function observe(memory, agentDir, session) {
  const status = await memory?.status?.();
  if (status?.backend !== BACKEND || !status.active) return null;
  return readBank(bankPath(agentDir, status.scope), session);
}

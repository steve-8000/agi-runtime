import { check, stable } from './util.mjs';
import { verifyEvidence } from './evidence.mjs';

// The model is the only transport to canonical memory: this process cannot call an MCP tool
// (ctx.invokeTool delegates to a same-named built-in only). What this module owns is the one
// pre-send check that is not about the input alone: a citation must name a file range as it is
// now. Nothing a tool returns moves journal state; an uncertain write is closed by reading the
// record back and attesting to it.

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

export function evidenceIsCurrent(store, workspace, root, ids) {
  store.assertEvidence(workspace, ids);
  for (const evidenceId of ids) {
    const row = store.evidence(evidenceId);
    check(row && verifyEvidence(root, row.record), 'STALE_EVIDENCE');
  }
}
/** Evidence ids a canonical-memory write cites anywhere in its input. A citation of a changed file is refused before it is sent. */
export function citedEvidence(store, workspace, input) {
  const ids = new Set();
  for (const candidate of stable(input ?? null).match(UUID) ?? []) if (store.evidence(candidate)?.workspace === workspace) ids.add(candidate);
  return [...ids];
}

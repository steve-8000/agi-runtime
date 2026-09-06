import { check, digest } from './util.mjs';

export const VERSION = '0.3.0';
export const STATE_TYPE = 'clab.runtime.state.v3';
export const OLD_STATE_TYPES = new Set([STATE_TYPE, 'agi-runtime-state']);
export const DEFAULTS = Object.freeze({
  memoryReadTools: ['mcp__gbrain_recall', 'mcp__gbrain_entity', 'mcp__gbrain_context_pack', 'mcp__gbrain_delta', 'mcp__gbrain_synthesize'],
  memoryWriteTools: ['mcp__gbrain_remember', 'mcp__gbrain_forget'],
  searchTools: ['mcp__zvec_grep_search'],
});
export const READ = new Set(['read', 'grep', 'glob', 'ast_grep', 'web_search', 'runtime_status', 'runtime_evidence']);
// Control flow must remain available during recovery. No generic task worker is enabled here.
export const CONTROL = new Set(['goal', 'todo', 'ask', 'task', 'yield', 'hub', 'advise', 'runtime_checkpoint', 'runtime_reconcile']);
const LEGACY = new Set(['mode', 'blockOnUnknown', 'headlessEffects', 'requireApproval', 'structuredOperationTools', 'targets', 'recall', 'maxToolCalls', 'maxEffects', 'maxWallMs']);
export function config(raw = {}, warn = () => {}) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_RUNTIME_CONFIG');
  for (const k of Object.keys(raw)) {
    if (LEGACY.has(k)) warn(`Ignored retired runtime option: ${k}`);
    else check(k in DEFAULTS, 'UNKNOWN_RUNTIME_OPTION', k);
  }
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const value = raw[k] ?? DEFAULTS[k];
    check(Array.isArray(value) && value.every(x => typeof x === 'string' && /^[A-Za-z0-9_-]+$/.test(x)), 'INVALID_TOOL_LIST', k);
    out[k] = Object.freeze([...new Set(value)]);
  }
  check(!out.memoryReadTools.some(t => out.memoryWriteTools.includes(t)), 'OVERLAPPING_MEMORY_TOOLS');
  return Object.freeze(out);
}
export function effectiveCall(call) {
  let tool = call.toolName, input = call.input ?? {}, envelope = false;
  // Match a complete device name, not a substring of an arbitrary path. Unknown forms stay opaque.
  if (tool === 'write' && typeof input.path === 'string') {
    const match = /^xd:\/\/([A-Za-z0-9_-]+)$/.exec(input.path);
    if (match) {
      try {
        const body = JSON.parse(input.content ?? '{}');
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          tool = match[1]; input = body; envelope = true;
        }
      } catch { /* The native tool reports invalid arguments; no guessed dispatch. */ }
    }
  }
  return { tool, input, envelope };
}
export function classify(call, cfg) {
  const e = effectiveCall(call);
  if (cfg.memoryWriteTools.includes(e.tool)) return { ...e, kind: 'memory-write', scope: 'memory' };
  if (cfg.memoryReadTools.includes(e.tool)) return { ...e, kind: 'memory-read', scope: 'read' };
  if (READ.has(e.tool) || cfg.searchTools.includes(e.tool)) return { ...e, kind: 'read', scope: 'read' };
  if (CONTROL.has(e.tool)) return { ...e, kind: 'control', scope: 'control' };
  return { ...e, kind: 'workspace-write', scope: 'workspace' };
}
export const isEffect = op => op.scope === 'memory' || op.scope === 'workspace';
export const logicalId = (session, call, op) => digest({ session, call: call.toolCallId, tool: op.tool });
export const wireId = call => `${call.toolCallId}\0${call.toolName}`;
export function protocolBody(result) {
  if (result?.structuredContent?.protocol_version === 1) return result.structuredContent;
  const text = result?.content?.find(p => p?.type === 'text')?.text;
  if (typeof text !== 'string') return undefined;
  try { const body = JSON.parse(text); return body?.protocol_version === 1 ? body : undefined; }
  catch { return undefined; }
}
export function observation(result, isError, kind) {
  const body = (kind === 'memory-read' || kind === 'memory-write') ? protocolBody(result) : undefined;
  const exit = result?.details?.exitCode;
  const failed = !!isError || (typeof exit === 'number' && exit !== 0) || typeof body?.error === 'string';
  const ack = body && typeof body.id === 'string' && (['inserted','duplicate','superseded'].includes(body.status) || typeof body.expired === 'boolean');
  const ambiguous = kind === 'memory-write' && !ack;
  return { failed, ambiguous, exit: typeof exit === 'number' ? exit : null, hash: digest({ failed, exit: exit ?? null, content: result?.content ?? null }) };
}
export function reduceGroup(group) {
  const parts = [...group.parts.values()];
  const obs = parts.flatMap(p => [p.result, p.end].filter(Boolean));
  const anyFailure = obs.some(x => x.failed);
  const conflict = parts.some(p => p.result && p.end && (p.result.failed !== p.end.failed || p.result.exit !== p.end.exit));
  const complete = parts.length > 0 && parts.every(p => p.started ? !!p.end : !!(p.result || p.end));
  // An errored memory write may have committed; semantic dedup is not an exact request-key guarantee. Failure-wins alone would permit a blind retry.
  const uncertain = isEffect(group.op) && (group.changed || (group.op.kind === 'memory-write' && (anyFailure || obs.some(x => x.ambiguous))));
  return { state: uncertain ? 'unknown' : anyFailure ? 'failed' : complete ? 'succeeded' : 'executing', conflict,
    quality: parts.some(p => !p.started) ? 'includes-result-only' : 'start-and-end',
    complete, outcome: digest(obs) };
}
export function sourceRef(session, call, sessionFile) {
  return { session, toolCallId: call.toolCallId, wireTool: call.toolName, ...(sessionFile ? { sessionFile } : {}) };
}
export function clipBytes(value, max) {
  let text = String(value ?? '');
  if (Buffer.byteLength(text) <= max) return text;
  const suffix = '…'; let out = '';
  for (const c of text) { if (Buffer.byteLength(out + c + suffix) > max) break; out += c; }
  return out + suffix;
}

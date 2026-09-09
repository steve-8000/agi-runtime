import { check, digest, rejectObviousSecrets } from './util.mjs';

export const VERSION = '0.5.0';
export const STATE_TYPE = 'clab.runtime.state.v3';
export const OLD_STATE_TYPES = new Set([STATE_TYPE, 'agi-runtime-state']);
// Explicit maintenance mutates derived state, never user source or canonical memory.
export const INTELLIGENCE_TOOL = 'mcp__lazy_intel_code_intel';
const EMPTY_CONFIG = Object.freeze({});
export const READ = new Set(['read', 'grep', 'glob', 'ast_grep', 'web_search', 'runtime_status', 'runtime_evidence', INTELLIGENCE_TOOL]);
// Control flow must remain available during recovery. No generic task worker is enabled here.
export const CONTROL = new Set(['goal', 'todo', 'ask', 'task', 'yield', 'hub', 'advise', 'runtime_checkpoint', 'runtime_reconcile']);
const LEGACY = new Set(['searchTools', 'memoryReadTools', 'memoryWriteTools', 'mode', 'blockOnUnknown', 'headlessEffects', 'requireApproval', 'structuredOperationTools', 'targets', 'recall', 'maxToolCalls', 'maxEffects', 'maxWallMs']);
export function config(raw = {}, warn = () => {}) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_RUNTIME_CONFIG');
  for (const k of Object.keys(raw)) {
    if (LEGACY.has(k)) warn(`Ignored retired runtime option: ${k}`);
    else check(false, 'UNKNOWN_RUNTIME_OPTION', k);
  }
  return EMPTY_CONFIG;
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
export function classify(call) {
  const e = effectiveCall(call);
  if (e.tool === INTELLIGENCE_TOOL && ['sync', 'reindex', 'repair'].includes(e.input.operation))
    return { ...e, kind: 'derived-effect', scope: 'derived' };
  if (READ.has(e.tool)) return { ...e, kind: 'read', scope: 'read' };
  if (CONTROL.has(e.tool)) return { ...e, kind: 'control', scope: 'control' };
  return { ...e, kind: 'workspace-write', scope: 'workspace' };
}
export const isEffect = op => op.scope === 'workspace' || op.scope === 'derived';
export const logicalId = (session, call, op) => digest({ session, call: call.toolCallId, tool: op.tool });
export const wireId = call => `${call.toolCallId}\0${call.toolName}`;
export function observation(result, isError) {
  const exit = result?.details?.exitCode;
  const failed = !!isError || !!result?.isError || (typeof exit === 'number' && exit !== 0);
  return { failed, exit: typeof exit === 'number' ? exit : null, hash: digest({ failed, exit: exit ?? null, content: result?.content ?? null }) };
}
export function reduceGroup(group) {
  const parts = [...group.parts.values()];
  const obs = parts.flatMap(p => [p.result, p.end].filter(Boolean));
  const anyFailure = obs.some(x => x.failed);
  const conflict = parts.some(p => p.result && p.end && (p.result.failed !== p.end.failed || p.result.exit !== p.end.exit));
  const complete = parts.length > 0 && parts.every(p => p.started ? !!p.end : !!(p.result || p.end));
  // An input revision makes effects uncertain; a tool failure alone is not proof of rollback.
  const uncertain = isEffect(group.op) && group.changed;
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
// Public command diagnostics are bounded and share the existing secret-hygiene policy.
export function diagnosticText(value, lines = 12) {
  const text = String(value ?? '');
  try { rejectObviousSecrets(text); }
  catch { return '[diagnostic omitted: possible secret]'; }
  return clipBytes(text.trim().split('\n').filter(Boolean).slice(-lines).join('\n'), 2048);
}
// Child output is opaque. Only this fixed, typed summary crosses the public gate boundary.
export function publicProbe(probe) {
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) return null;
  const checks = {};
  let passed = probe.status === 'PASS';
  for (const name of ['processExited', 'attached', 'sharpshooter', 'oneIntelligenceTool', 'oneIndexLifecycle', 'nativeMultiTurn', 'intelligenceBackends', 'intelligenceReadOnly', 'nativeVerification', 'repairedBehavior', 'verifierUnchanged', 'runtimeHealthy']) {
    checks[name] = probe.checks?.[name] === true;
    passed &&= checks[name];
  }
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    status: passed ? 'PASS' : 'FAIL', model: '<configured>',
    runtimeVersion: probe.runtimeVersion === VERSION ? VERSION : null,
    durationMs: count(probe.durationMs), modelTurns: count(probe.modelTurns), checks,
    runtimeStatus: {
      health: probe.runtimeStatus?.health === 'healthy' ? 'healthy' : probe.runtimeStatus?.health === 'degraded' ? 'degraded' : null,
      version: probe.runtimeStatus?.version === VERSION ? VERSION : null,
      totalUnknown: count(probe.runtimeStatus?.totalUnknown),
    },
    fixtureBeforeExit: count(probe.fixtureBeforeExit), fixtureAfterExit: count(probe.fixtureAfterExit), processExit: count(probe.processExit),
  };
}

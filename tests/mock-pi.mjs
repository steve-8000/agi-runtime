// An API-shaped stand-in for OMP's ExtensionAPI/ExtensionContext at the tag in compat/tested-versions.json.
// It is not OMP: the live check is `scripts/compat.mjs --live`, which runs the real binary.
export function mockPi({ version = '18.1.10', agentDir, omit = [] } = {}) {
  const handlers = new Map(), tools = new Map(), commands = new Map(), log = [];
  const schema = { int() { return this; }, min() { return this; } };
  const pi = {
    zod: { object: () => schema, string: () => schema, number: () => schema, array: () => schema, enum: () => schema },
    logger: { error: m => log.push(['error', m]), warn: m => log.push(['warn', m]), info: m => log.push(['info', m]) },
    pi: { VERSION: version, getAgentDir: () => agentDir },
    setLabel(label) { pi.label = label; },
    on: (name, handler) => handlers.set(name, handler),
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command)
  };
  for (const key of omit) delete pi[key];
  return { pi, handlers, tools, commands, log };
}
export function mockCtx({ cwd, hasUI = true, session = 'mock-session', select = async (_title, options) => options[0] } = {}) {
  const notices = [], timers = new Set();
  return {
    cwd, hasUI, notices, timers,
    sessionManager: { getSessionId: () => session },
    setInterval: fn => { const h = { fn }; timers.add(h); return h; }, clearTimer: h => timers.delete(h),
    abort() { this.aborted = true; },
    ui: { select, notify: (message, type) => notices.push({ message, type }), confirm: async () => true, setStatus() {} }
  };
}
/** Emit the exact sequence OMP's agent loop and wrapper produce for one model-issued tool call. */
export async function dispatch(handlers, ctx, { toolCallId, toolName, input, isError = false, details = { exitCode: 0 } }) {
  const callResult = await handlers.get('tool_call')({ type: 'tool_call', toolCallId, toolName, input }, ctx);
  if (callResult?.block) return callResult;
  const args = callResult?.input ?? input;
  await handlers.get('tool_execution_start')?.({ type: 'tool_execution_start', toolCallId, toolName, args }, ctx);
  const content = [{ type: 'text', text: 'ok' }];
  await handlers.get('tool_result')?.({ type: 'tool_result', toolCallId, toolName, input: args, content, details, isError }, ctx);
  await handlers.get('tool_execution_end')?.({ type: 'tool_execution_end', toolCallId, toolName, result: { content, details }, isError }, ctx);
  return callResult;
}

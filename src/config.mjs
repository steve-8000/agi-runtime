import { check } from './util.mjs';

const MODES = ['enforce', 'observe'];
const HEADLESS = ['allow', 'deny'];
const RECALL = ['require', 'advise'];
const NAME = /^[A-Za-z0-9_-]+$/;

// Operator-owned runtime policy. Lives outside every workspace (~/.omp/runtime/config.json);
// retrieved content, AGENTS files and model output can never change it.
export function runtimeConfig(raw = {}) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_RUNTIME_CONFIG');
  const defaults = {
    mode: 'enforce', blockOnUnknown: true, headlessEffects: 'allow',
    requireApproval: [], memoryReadTools: [], memoryWriteTools: [],
    recall: { mode: 'advise', tools: [] }, structuredOperationTools: [], targets: {}
  };
  for (const key of Object.keys(raw)) check(Object.hasOwn(defaults, key), 'UNKNOWN_RUNTIME_CONFIG_KEY', key);
  const config = { ...defaults, ...raw };
  check(MODES.includes(config.mode), 'INVALID_RUNTIME_MODE');
  check(HEADLESS.includes(config.headlessEffects), 'INVALID_HEADLESS_POLICY');
  check(typeof config.blockOnUnknown === 'boolean', 'INVALID_RUNTIME_CONFIG');
  for (const key of ['requireApproval', 'memoryReadTools', 'memoryWriteTools', 'structuredOperationTools']) {
    check(Array.isArray(config[key]) && config[key].every(x => typeof x === 'string' && NAME.test(x)), 'INVALID_TOOL_ALLOWLIST');
    config[key] = Object.freeze([...new Set(config[key])]);
  }
  // A tool is a canonical-memory read or write, never both: the two classes carry different gates.
  check(!config.memoryReadTools.some(x => config.memoryWriteTools.includes(x)), 'INVALID_TOOL_ALLOWLIST');
  // Recall is gated on exact tool names that are also classified as canonical-memory reads.
  const recall = config.recall;
  check(recall && typeof recall === 'object' && !Array.isArray(recall) && RECALL.includes(recall.mode), 'INVALID_RECALL_POLICY');
  for (const key of Object.keys(recall)) check(['mode', 'tools'].includes(key), 'INVALID_RECALL_POLICY', key);
  const tools = recall.tools ?? [];
  check(Array.isArray(tools) && tools.every(x => typeof x === 'string' && config.memoryReadTools.includes(x)), 'UNKNOWN_RECALL_TOOL');
  check(recall.mode !== 'require' || tools.length > 0, 'RECALL_TOOLS_REQUIRED');
  config.recall = Object.freeze({ mode: recall.mode, tools: Object.freeze([...new Set(tools)]) });
  check(config.targets && typeof config.targets === 'object' && !Array.isArray(config.targets), 'INVALID_TARGET_MAP');
  check(Object.values(config.targets).every(x => typeof x === 'string' && x.length >= 16), 'INVALID_TARGET_FINGERPRINT');
  config.targets = Object.freeze({ ...config.targets });
  return Object.freeze(config);
}

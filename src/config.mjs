import { check } from './util.mjs';

const MODES = ['enforce', 'observe'];
const HEADLESS = ['allow', 'deny'];
const NAME = /^[A-Za-z0-9_-]+$/;

// Operator-owned runtime policy. Lives outside every workspace (~/.omp/runtime/config.json);
// retrieved content, AGENTS files and model output can never change it.
export function runtimeConfig(raw = {}) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'INVALID_RUNTIME_CONFIG');
  const defaults = {
    mode: 'enforce', maxEffects: 100, maxToolCalls: 500, maxWallMs: 3600000,
    blockOnUnknown: true, headlessEffects: 'allow',
    requireApproval: [], memoryReadTools: [], structuredOperationTools: [], targets: {}
  };
  for (const key of Object.keys(raw)) check(Object.hasOwn(defaults, key), 'UNKNOWN_RUNTIME_CONFIG_KEY', key);
  const config = { ...defaults, ...raw };
  check(MODES.includes(config.mode), 'INVALID_RUNTIME_MODE');
  check(HEADLESS.includes(config.headlessEffects), 'INVALID_HEADLESS_POLICY');
  check(typeof config.blockOnUnknown === 'boolean', 'INVALID_RUNTIME_CONFIG');
  for (const key of ['maxEffects', 'maxToolCalls', 'maxWallMs']) {
    check(Number.isSafeInteger(config[key]) && config[key] > 0, 'INVALID_RUNTIME_BUDGET', key);
  }
  for (const key of ['requireApproval', 'memoryReadTools', 'structuredOperationTools']) {
    check(Array.isArray(config[key]) && config[key].every(x => typeof x === 'string' && NAME.test(x)), 'INVALID_TOOL_ALLOWLIST');
    config[key] = Object.freeze([...new Set(config[key])]);
  }
  check(config.targets && typeof config.targets === 'object' && !Array.isArray(config.targets), 'INVALID_TARGET_MAP');
  check(Object.values(config.targets).every(x => typeof x === 'string' && x.length >= 16), 'INVALID_TARGET_FINGERPRINT');
  config.targets = Object.freeze({ ...config.targets });
  return Object.freeze(config);
}

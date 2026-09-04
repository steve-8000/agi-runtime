import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { check, digest } from './util.mjs';
import { runtimeConfig } from './config.mjs';

// ~/.omp/agent (or the profile's agent dir) is OMP's; ~/.omp/runtime is ours.
// Both survive `brew upgrade omp`: the binary is replaced, these directories are not.
export function defaultAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent');
}
export function runtimeLayout(agentDir = defaultAgentDir()) {
  const root = resolve(process.env.OMP_RUNTIME_DIR ?? join(dirname(resolve(agentDir)), 'runtime'));
  return Object.freeze({
    root,
    journals: join(root, 'journals'),
    compat: join(root, 'compat'),
    config: resolve(process.env.OMP_RUNTIME_CONFIG ?? join(root, 'config.json')),
    extensionLink: join(resolve(agentDir), 'extensions', 'agi-runtime')
  });
}
const inside = (path, root) => path === root || path.startsWith(root + '/');
/**
 * The journal must live outside the working tree, or yolo tools could edit their own audit log.
 * Both sides are compared as real paths: a runtime dir that is a symlink into the workspace is refused.
 */
export function journalPath(layout, workspaceRoot) {
  const root = realpathSync(workspaceRoot);
  mkdirSync(layout.journals, { recursive: true, mode: 0o700 });
  const runtime = realpathSync(layout.root);
  check(!inside(runtime, root) && !inside(root, runtime), 'STATE_MUST_BE_OUTSIDE_WORKSPACE');
  return join(realpathSync(layout.journals), `${digest({ root })}.sqlite`);
}
export function loadRuntimeConfig(layout) {
  if (!existsSync(layout.config)) return runtimeConfig();
  // Trusted operator input; a broken file fails closed rather than silently falling back to defaults.
  return runtimeConfig(JSON.parse(readFileSync(realpathSync(layout.config), 'utf8')));
}

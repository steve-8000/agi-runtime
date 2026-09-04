import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, sep } from 'node:path';

const SENSITIVE = /(^|[/\\])(?:\.env(?:\..*)?|\.ssh|\.aws|\.kube|\.git|\.github|\.omp|\.claude|AGENTS\.md|CLAUDE\.md)([/\\]|$)|\.(?:pem|key|p12|pfx)$/i;

/**
 * A literal, non-sensitive path inside the workspace with no symlink component.
 * Rejects devices/URLs, escapes, policy/credential files and every symlink (even in-tree ones).
 * This is a classification aid for the journal, not a substitute for OS sandboxing.
 */
export function ordinaryWorkspacePath(root, path) {
  try {
    if (typeof path !== 'string' || !/^[A-Za-z0-9_./ -]+$/.test(path)) return false;
    root = realpathSync(root);
    const absolute = resolve(root, path), rel = relative(root, absolute);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    if (SENSITIVE.test(rel)) return false;
    let ancestor = absolute;
    while (!existsSync(ancestor)) {
      // A dangling symlink must not be mistaken for a nonexistent regular path.
      try { if (lstatSync(ancestor).isSymbolicLink()) return false; } catch (e) { if (e.code !== 'ENOENT') return false; }
      ancestor = dirname(ancestor);
    }
    return realpathSync(ancestor) === ancestor;
  } catch { return false; }
}

/** Only OMP's inspected, literal `write({path,content})` form. Executables and shebang files need review. */
export function ordinaryWorkspaceWrite(root, input) {
  if (!input || typeof input.content !== 'string') return false;
  if (Object.keys(input).some(k => !['path', 'content'].includes(k))) return false;
  if (input.content.startsWith('#!') || !ordinaryWorkspacePath(root, input.path)) return false;
  try {
    const absolute = resolve(realpathSync(root), input.path);
    if (existsSync(absolute)) {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || (stat.mode & 0o111) !== 0) return false;
    }
    return true;
  } catch { return false; }
}

/** Reads that touch credential, policy or out-of-tree paths are journaled for audit; never blocked here. */
export function sensitiveRead(root, path) {
  if (typeof path !== 'string' || path.includes('://')) return false;
  try {
    root = realpathSync(root);
    const rel = relative(root, resolve(root, path.replace(/:[^/]*$/, '')));
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || SENSITIVE.test(rel);
  } catch { return true; }
}

import { constants, openSync, closeSync, readFileSync, fstatSync, realpathSync } from 'node:fs';
import { relative, resolve, isAbsolute, sep } from 'node:path';
import { check, hash, rejectObviousSecrets } from './util.mjs';

export function workspacePath(root, path) {
  root = realpathSync(root);
  check(typeof path === 'string' && path.length > 0 && !path.includes('\0') && !path.includes('://'), 'INVALID_PATH');
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  check(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'PATH_ESCAPE');
  check(!/(^|[/\\])(?:\.env(?:\..*)?|\.ssh|\.aws|\.kube|\.git|\.zvec-grep|\.runtime)([/\\]|$)|\.(?:pem|key|p12|pfx)$/i.test(rel), 'SENSITIVE_PATH');
  const real = realpathSync(absolute);
  // Reject all symlink traversal, including links that remain within the workspace.
  check(real === absolute, 'SYMLINK_PATH');
  return { root, absolute, relative: rel };
}
export function captureEvidence(root, path, start = 1, end = start, now = Date.now()) {
  check(Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start, 'INVALID_RANGE');
  const p = workspacePath(root, path);
  const fd = openSync(p.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    check(before.isFile() && before.size <= 2n * 1024n * 1024n, 'FILE_TOO_LARGE_OR_NOT_REGULAR');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    check(before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'FILE_CHANGED_DURING_READ');
    check(!bytes.includes(0), 'BINARY_EVIDENCE');
    const lines = bytes.toString('utf8').split('\n');
    check(end <= lines.length, 'RANGE_OUT_OF_BOUNDS');
    const excerpt = lines.slice(start - 1, end).join('\n');
    rejectObviousSecrets(excerpt);
    return {
      kind: 'workspace-file', path: p.relative, start, end,
      fileHash: hash(bytes), excerptHash: hash(excerpt), observedAt: now,
      // Original content is not persisted in the journal.
      authority: 'source-content', verified: true
    };
  } finally { closeSync(fd); }
}
export function verifyEvidence(root, record) {
  try {
    check(record.kind === 'workspace-file', 'UNSUPPORTED_EVIDENCE');
    const current = captureEvidence(root, record.path, record.start, record.end);
    return current.fileHash === record.fileHash && current.excerptHash === record.excerptHash;
  } catch { return false; }
}
export function zvecRequest(root, query, { limit = 5, waitForFresh = false } = {}) {
  check(typeof query === 'string' && query.trim() && query.length <= 4000, 'INVALID_QUERY');
  check(Number.isInteger(limit) && limit >= 1 && limit <= 10, 'INVALID_LIMIT');
  return {
    root: realpathSync(root), query: query.trim(), limit,
    freshness: waitForFresh ? 'wait_for_fresh' : 'eventual', autoUpdate: false
  };
}
export function zvecFreshness(text) {
  const match = /^freshness:\s*(fresh|possibly_stale)\s*$/m.exec(text);
  return match?.[1] ?? 'unknown';
}

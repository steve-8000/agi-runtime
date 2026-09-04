// Both engines expose prepare/exec and positional statement parameters.
export async function openDatabase(path) {
  if (globalThis.Bun) {
    const { Database } = await import('bun:sqlite');
    return new Database(path, { create: true, strict: true });
  }
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path);
}

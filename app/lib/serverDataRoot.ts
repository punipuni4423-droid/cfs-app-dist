import path from 'node:path';

// Standalone Next changes cwd to its build directory. Persistent stores must
// follow the launcher app root instead; keep cwd compatibility for development.
export function serverDataRoot(): string {
  const appDir = process.env.CFS_APP_DIR?.trim();
  if (appDir && !path.isAbsolute(appDir)) {
    throw new Error('CFS_APP_DIR must be an absolute path.');
  }
  return path.join(appDir || process.cwd(), 'data');
}

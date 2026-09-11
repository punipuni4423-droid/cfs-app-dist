import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { serverDataRoot } from './serverDataRoot';

// Both stores participate in the same lock and durable commit record. A failed
// application of a committed record is retried before any reader/writer proceeds.
export function createLocalProjectStore(directory: string, io: typeof fs = fs) {
  const projectsFile = path.join(directory, 'projects.json');
  const trashFile = path.join(directory, 'trash', 'trash.json');
  const journalFile = path.join(directory, 'project-trash.transaction.json');
  const lockDir = path.join(directory, 'project-store.lock');

  async function readJson(file: string, fallback: unknown): Promise<unknown> {
    try { return JSON.parse(await io.readFile(file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw error;
    }
  }

  async function atomicWrite(file: string, value: unknown): Promise<void> {
    await io.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await io.open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await io.rename(temporary, file);
  }

  async function recover(): Promise<void> {
    const pending = await readJson(journalFile, null);
    if (pending === null) return;
    const record = pending as { version?: unknown; projects?: unknown; trash?: unknown };
    if (record.version !== 1 || !Array.isArray(record.projects) || !record.trash || typeof record.trash !== 'object') {
      throw new Error('Invalid project transaction record; recovery is required.');
    }
    // Retain the durable record until BOTH replacements succeeded. Even when
    // disk IO fails, the only project copy cannot disappear from all stores.
    await atomicWrite(trashFile, record.trash);
    await atomicWrite(projectsFile, record.projects);
    await io.unlink(journalFile);
  }

  async function locked<T>(operation: () => Promise<T>): Promise<T> {
    await io.mkdir(directory, { recursive: true });
    const owner = `owner-${process.pid}-${randomUUID()}`;
    const candidate = `${lockDir}.${owner}`;
    // Publish a populated directory atomically: a crash can never leave a
    // newly-acquired lock without an identifiable owner.
    await io.mkdir(candidate);
    await io.writeFile(path.join(candidate, owner), '');
    const started = Date.now();
    let acquired = false;
    async function removeEmptyLock(): Promise<void> {
      try { await io.rmdir(lockDir); }
      catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    try {
      for (;;) {
        if (Date.now() - started >= 5000) throw new Error('Project store is busy. Please try again.');
        try { await io.rename(candidate, lockDir); acquired = true; break; }
        catch (error) {
          let owners: string[];
          try { owners = await io.readdir(lockDir); }
          catch (readError) {
            if ((readError as NodeJS.ErrnoException).code === 'ENOENT' && ['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
            throw error;
          }
          if (owners.length === 0) await removeEmptyLock();
          else if (owners.length === 1 && /^owner-\d+-[\da-f-]+$/.test(owners[0])) {
            const pid = Number(owners[0].split('-')[1]);
            let dead = false;
            try { process.kill(pid, 0); }
            catch (signalError) { dead = (signalError as NodeJS.ErrnoException).code === 'ESRCH'; }
            if (dead) {
              // Only unlink the exact dead owner's unique file. A competing
              // reaper cannot delete a replacement live owner's populated dir.
              try { await io.unlink(path.join(lockDir, owners[0])); }
              catch (unlinkError) { if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError; }
              await removeEmptyLock();
            }
          }
          // A live PID (including a reused PID) is never expired by elapsed time.
          if (Date.now() - started >= 5000) throw new Error('Project store is busy. Please try again.');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      await recover();
      return await operation();
    } finally {
      if (acquired) {
        await io.unlink(path.join(lockDir, owner));
        await removeEmptyLock();
      } else {
        await io.unlink(path.join(candidate, owner));
        await io.rmdir(candidate);
      }
    }
  }

  return {
    locked,
    readProjects: () => readJson(projectsFile, []),
    readTrash: async () => {
      // Preserve the legacy empty-trash-file behavior.
      try {
        const raw = await io.readFile(trashFile, 'utf8');
        return raw.trim() ? JSON.parse(raw) as unknown : { projects: [], roomTypes: [], updatedAt: '' };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projects: [], roomTypes: [], updatedAt: '' };
        throw error;
      }
    },
    writeProjects: (projects: unknown) => atomicWrite(projectsFile, projects),
    writeTrash: (trash: unknown) => atomicWrite(trashFile, trash),
    commit: async (projects: unknown[], trash: unknown) => {
      await atomicWrite(journalFile, { version: 1, projects, trash });
      await recover();
    },
  };
}

export const localProjectStore = createLocalProjectStore(serverDataRoot());

/**
 * Filesystem containment for evolve/ writes — enforced at open time, not
 * before it.
 *
 * Round-2 review proved that path-based checks (lstat/realpath plus
 * O_NOFOLLOW on the final component) cannot close the check-to-open race: a
 * component can be swapped for a symlink after any check and before the open
 * that follows it. This module therefore binds every write to directory
 * inodes, in the spirit of an openat() walk:
 *
 *   - withBoundRoot() chdir()s to the workspace root once, so the kernel binds
 *     cwd to the root's inode (process.cwd() reports the resolved physical
 *     path);
 *   - enterDirectory()/enterOrCreateDirectory() descend one component at a
 *     time: lstat the name relative to the bound cwd (a symlink is refused),
 *     chdir into it, then require process.cwd() to be exactly the expected
 *     physical path — this catches a component swapped for a symlink between
 *     the lstat and the chdir, even though chdir itself has no O_NOFOLLOW;
 *   - every file open is relative to the bound directory and carries
 *     O_NOFOLLOW, so the kernel resolves it against the bound inode: a
 *     symlink planted at the final component is refused, and a symlink
 *     swapped in at any ancestor after verification cannot redirect the write.
 *
 * Creation is atomic: directories are created with mkdir and an EEXIST race
 * is re-checked, never pre-checked; new files use O_CREAT|O_EXCL; wiki appends
 * use O_APPEND. The cwd is process-global state, so every entry point restores
 * it in a finally and all operations here are synchronous — no other code can
 * observe the bound directory.
 */
import { closeSync, constants, lstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { EvolveError, nodeErrorCode } from './errors.ts';

const NOFOLLOW = constants.O_NOFOLLOW;

export type EntryKind = 'missing' | 'symlink' | 'directory' | 'file' | 'other';

/**
 * Bind the process to the workspace root's directory inode for the duration of
 * `fn`; `anchor` is the resolved physical path. Missing roots are created
 * first (init parity); everything below them is still verified component by
 * component.
 */
export function withBoundRoot<T>(root: string, fn: (anchor: string) => T): T {
  const originalCwd = process.cwd();
  enterRoot(root);
  const anchor = process.cwd();
  try {
    return fn(anchor);
  } finally {
    process.chdir(originalCwd);
  }
}

function enterRoot(root: string): void {
  try {
    process.chdir(root);
  } catch (error) {
    if (nodeErrorCode(error) !== 'ENOENT') throw error;
    mkdirSync(root, { recursive: true });
    process.chdir(root);
  }
}

/** Descend into an existing component of the bound directory; missing is a layout violation. */
export function enterDirectory(name: string, from: string): string {
  return enterBoundDirectory(name, from, false);
}

/** Descend into a component, creating it atomically when it is missing. */
export function enterOrCreateDirectory(name: string, from: string): string {
  return enterBoundDirectory(name, from, true);
}

function enterBoundDirectory(name: string, from: string, create: boolean): string {
  let kind = entryKind(name);
  if (kind === 'missing' && create) {
    try {
      mkdirSync(name);
    } catch (error) {
      if (nodeErrorCode(error) !== 'EEXIST') throw error;
    }
    kind = entryKind(name);
  }
  if (kind !== 'directory') throw refuseEntry(name, from, kind);
  const to = join(from, name);
  process.chdir(name);
  if (process.cwd() !== to) {
    throw new EvolveError(
      'unsafe-path',
      `${name} resolves outside ${from}; a symlink swapped in after the check is refused`,
    );
  }
  return to;
}

function refuseEntry(name: string, from: string, kind: EntryKind): EvolveError {
  const path = join(from, name);
  if (kind === 'missing') {
    return new EvolveError('layout-violation', `${path} does not exist`);
  }
  return new EvolveError('unsafe-path', `${path} must be a real directory; symlinks and non-directories are refused`);
}

/** lstat a single component relative to the bound cwd, without following symlinks. */
export function entryKind(name: string): EntryKind {
  let stat;
  try {
    stat = lstatSync(name);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  return 'other';
}

/** Create a new file atomically; an existing file — even a symlink — is refused. */
export function createFileHere(name: string, contents: string): void {
  withOpenHere(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, (fd) => {
    writeAll(fd, contents);
  });
}

/** Create or replace a regular file; a symlink final component is refused. */
export function replaceFileHere(name: string, contents: string): void {
  withOpenHere(name, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, (fd) => {
    writeAll(fd, contents);
  });
}

/** Append to an existing regular file; refuses to create it and returns the full new bytes. */
export function appendFileHere(name: string, contents: string): Buffer {
  return withOpenHere(name, constants.O_RDWR | constants.O_APPEND, (fd) => {
    writeAll(fd, contents);
    return readAll(fd);
  });
}

/** Read a regular file; a symlink final component is refused. */
export function readFileHere(name: string): Buffer {
  return withOpenHere(name, constants.O_RDONLY, (fd) => readAll(fd));
}

function withOpenHere<T>(name: string, flags: number, fn: (fd: number) => T): T {
  let fd: number;
  try {
    fd = openSync(name, flags | NOFOLLOW, 0o644);
  } catch (error) {
    if (nodeErrorCode(error) === 'ELOOP') {
      throw new EvolveError('unsafe-path', `${name} is a symlink; evolve writes do not follow symlinks`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    return fn(fd);
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, contents: string): void {
  const bytes = Buffer.from(contents, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset);
  }
}

function readAll(fd: number): Buffer {
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(8192);
  let position = 0;
  for (;;) {
    const read = readSync(fd, chunk, 0, chunk.length, position);
    if (read === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, read)));
    position += read;
  }
  return Buffer.concat(chunks);
}

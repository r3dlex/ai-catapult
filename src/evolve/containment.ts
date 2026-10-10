/**
 * Filesystem containment for evolve/ writes. A symlink inside the workspace
 * is not a boundary: lstat refuses it, and opens use O_NOFOLLOW so a swap
 * between the check and the write cannot escape either.
 */
import { closeSync, constants, lstatSync, openSync, realpathSync, writeSync } from 'node:fs';
import { EvolveError, nodeErrorCode } from './errors.ts';

const NOFOLLOW = constants.O_NOFOLLOW;

export function assertRealDirectory(path: string): string {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') {
      throw new EvolveError('layout-violation', `${path} does not exist`, { cause: error });
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new EvolveError('unsafe-path', `${path} must be a real directory; symlinks are refused`);
  }
  return realpathSync(path);
}

/** Create or replace a regular file. O_NOFOLLOW refuses a symlink final component. */
export function writeRegularFile(path: string, contents: string, replace: boolean): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | NOFOLLOW | (replace ? constants.O_TRUNC : constants.O_EXCL);
  const fd = openNoFollow(path, flags);
  try {
    writeAll(fd, contents);
  } finally {
    closeSync(fd);
  }
}

/** Append to an existing regular file. Does not create, truncate, or follow a symlink. */
export function appendRegularFile(path: string, contents: string): void {
  const flags = constants.O_WRONLY | constants.O_APPEND | NOFOLLOW;
  const fd = openNoFollow(path, flags);
  try {
    writeAll(fd, contents);
  } finally {
    closeSync(fd);
  }
}

function openNoFollow(path: string, flags: number): number {
  try {
    return openSync(path, flags, 0o644);
  } catch (error) {
    if (nodeErrorCode(error) === 'ELOOP') {
      throw new EvolveError('unsafe-path', `${path} is a symlink; evolve writes do not follow symlinks`, { cause: error });
    }
    throw error;
  }
}

function writeAll(fd: number, contents: string): void {
  const bytes = Buffer.from(contents, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset);
  }
}

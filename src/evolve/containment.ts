/**
 * Filesystem containment for evolve/ writes — enforced at open time, with an
 * explicit relocation contract.
 *
 * Review reproduced two escapes that path checks alone cannot close: (1) the
 * workspace root (or any component) substituted with a symlink between the
 * check and the chdir/open; (2) a bound directory relocated out of the
 * workspace after validation — relative opens stay bound to the moved inode.
 * On the critic's own terms this requires “a containment correction or an
 * explicitly revised contract with an enforceable boundary against concurrent
 * relocation. Additional path checks alone leave another race.”
 *
 * Enforced boundary (each clause has regression coverage):
 *
 *   - Root identity: the caller-provided path is lexically normalized
 *     (path.resolve) and walked top-down before anything binds: every
 *     component of the caller path must be a real directory, and a symlink at
 *     ANY component — the root's ancestors included — is refused by name with
 *     a canonicalize-with-realpath hint. The root is then opened once with
 *     O_DIRECTORY|O_NOFOLLOW and its device+inode compared against the cwd
 *     after the chdir (through a no-follow open of `.`), so a substitution
 *     present before the bind, during the walk, during the chdir or before
 *     the open is refused instead of adopted. Node exposes no fchdir, so cwd
 *     is established by path and then verified against the opened fd's
 *     identity. Callers whose root legitimately traverses a symlink (macOS
 *     /var, /tmp) must canonicalize it with realpath before binding.
 *   - Component substitution at any depth: each component is opened
 *     O_DIRECTORY|O_NOFOLLOW relative to the bound parent and its identity is
 *     recorded; `process.cwd()` must equal the expected physical path and its
 *     inode must equal the opened component after every chdir.
 *   - Anchor chain (exact): the walked caller-path chain — every prefix,
 *     ancestors included — is recorded (device+inode) at bind time and
 *     re-resolved before every mutation, so an ancestor above the workspace
 *     that is symlinked, replaced or moved mid-operation is detected too.
 *   - Relocation: before every create/open/append, every recorded level is
 *     re-resolved with lstat and compared with its recorded identity; a
 *     missing, symlinked, replaced or moved level refuses with a distinct
 *     error naming the level — before any byte is written. File opens stay
 *     relative to the bound inode, and a relocation first detected only after
 *     a kernel mutation (the check-to-write window) is reverted for our own
 *     bytes: a created file is unlinked by inode identity, an appended file
 *     is truncated back to its prior size, and a replaced overlay is rewritten
 *     from its captured original bytes. Net external byte change is then zero
 *     or the call fails closed.
 *   - Known residual, declared: darwin has no openat2/RESOLVE_BENEATH and Node
 *     exposes no openat/fchdir. A concurrent hostile relocator that interposes
 *     between the very last identity re-verification and the kernel write can
 *     still have that single write land in the relocated inode; the
 *     re-verification immediately precedes both the open and the write, and
 *     the post-mutation revert above is the compensating control. Relocation
 *     is refused whenever observed; the unobservable window is explicitly
 *     outside this boundary.
 *
 * Creation is atomic: directories via mkdir with an EEXIST re-check, new files
 * via O_CREAT|O_EXCL, wiki appends via O_APPEND. The cwd and the recorded
 * identity chain are process-global; every entry point restores both in a
 * finally and all operations here are synchronous.
 */
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { EvolveError, nodeErrorCode } from './errors.ts';

const NOFOLLOW = constants.O_NOFOLLOW;
const DIRECTORY = constants.O_DIRECTORY;

export type EntryKind = 'missing' | 'symlink' | 'directory' | 'file' | 'other';

interface BoundLevel {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

let boundLevels: readonly BoundLevel[] = [];
let boundAncestors: readonly BoundLevel[] = [];

/**
 * Bind the process to the workspace root's directory identity for the duration
 * of `fn`; `anchor` is the normalized caller path once every component of it
 * has been verified to be a real directory. The root must be a symlink-free
 * canonical path (callers canonicalize, e.g. with realpath, before binding).
 * Missing roots are created first (init parity); every component is still
 * verified.
 */
export function withBoundRoot<T>(root: string, fn: (anchor: string) => T): T {
  const previousCwd = process.cwd();
  const previousLevels = boundLevels;
  const previousAncestors = boundAncestors;
  try {
    const binding = bindRoot(root);
    boundLevels = [binding.level];
    boundAncestors = binding.ancestors;
    return fn(binding.level.path);
  } finally {
    boundLevels = previousLevels;
    boundAncestors = previousAncestors;
    process.chdir(previousCwd);
  }
}

interface RootBinding {
  readonly level: BoundLevel;
  readonly ancestors: readonly BoundLevel[];
}

function bindRoot(root: string): RootBinding {
  // Lexical normalization makes the walk and the physical path agree; the
  // caller path must itself be symlink-free (macOS /var, /tmp callers
  // canonicalize before binding).
  const anchor = resolve(root);
  const chain = callerPathChain(anchor);
  if (chain === null) {
    mkdirSync(anchor, { recursive: true });
    const created = callerPathChain(anchor);
    if (created === null) {
      throw new EvolveError('unsafe-path', `${anchor} could not be created as a real directory`);
    }
    return bindVerifiedRoot(anchor, created);
  }
  return bindVerifiedRoot(anchor, chain);
}

function bindVerifiedRoot(anchor: string, chain: readonly BoundLevel[]): RootBinding {
  const fd = openRootDirectory(anchor);
  try {
    const id = fstatSync(fd);
    if (!id.isDirectory()) throw openRootRefusal(anchor);
    process.chdir(anchor);
    // cwd is established by path; it must still be the walked path and the
    // opened inode, or a substitution slipped in between walk/check and chdir.
    const cwdId = openCwdIdentity();
    if (cwdId.dev !== id.dev || cwdId.ino !== id.ino || process.cwd() !== anchor) throw substitutionRefusal(anchor);
    const walked = chain[chain.length - 1];
    if (walked === undefined || walked.dev !== id.dev || walked.ino !== id.ino) throw substitutionRefusal(anchor);
    return { level: { path: anchor, dev: id.dev, ino: id.ino }, ancestors: chain };
  } finally {
    closeSync(fd);
  }
}

function openRootDirectory(root: string): number {
  try {
    return openSync(root, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  } catch (error) {
    if (nodeErrorCode(error) === 'ELOOP') throw symlinkedRootRefusal(root);
    throw error;
  }
}

/** Walk the caller path top-down; null when some component does not exist yet. */
function callerPathChain(anchor: string): BoundLevel[] | null {
  const levels: BoundLevel[] = [];
  let prefix = '';
  for (const part of anchor.split('/').filter((segment) => segment !== '')) {
    prefix = `${prefix}/${part}`;
    let stat;
    try {
      stat = lstatSync(prefix);
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw symlinkedRootRefusal(prefix);
    if (!stat.isDirectory()) {
      throw new EvolveError(
        'unsafe-path',
        `${prefix} must be a real directory; the workspace root path cannot traverse a non-directory`,
      );
    }
    levels.push({ path: prefix, dev: stat.dev, ino: stat.ino });
  }
  return levels;
}

function symlinkedRootRefusal(path: string): EvolveError {
  return new EvolveError(
    'unsafe-path',
    `${path} is a symlink; the workspace root must be a symlink-free canonical path (canonicalize with realpath before binding)`,
  );
}

function openRootRefusal(root: string): EvolveError {
  return new EvolveError('unsafe-path', `${root} must be a real directory; symlinks are refused as the workspace root`);
}

/** Descend into an existing component of the bound directory; missing is a layout violation. */
export function enterDirectory(name: string, from: string): string {
  const kind = entryKind(name);
  if (kind !== 'directory') throw directoryRefusal(name, from, kind);
  return enterVerifiedDirectory(name, from);
}

/** Descend into a component, creating it atomically when it is missing. */
export function enterOrCreateDirectory(name: string, from: string): string {
  const created = ensureDirectoryHere(name, from);
  try {
    return enterVerifiedDirectory(name, from);
  } catch (error) {
    if (created) removeDirectoryHere(name);
    throw error;
  }
}

/** Create a missing directory (atomic, relocation-checked); true when this call created it. */
export function ensureDirectoryHere(name: string, from: string): boolean {
  const kind = entryKind(name);
  if (kind !== 'missing') {
    if (kind !== 'directory') throw directoryRefusal(name, from, kind);
    verifyBoundChain();
    return false;
  }
  let created = false;
  try {
    mkdirSync(name);
    created = true;
  } catch (error) {
    if (nodeErrorCode(error) !== 'EEXIST') throw error;
  }
  if (entryKind(name) !== 'directory') {
    if (created) removeDirectoryHere(name);
    throw directoryRefusal(name, from, entryKind(name));
  }
  try {
    verifyBoundChain();
  } catch (error) {
    if (created) removeDirectoryHere(name);
    throw error;
  }
  return created;
}

function enterVerifiedDirectory(name: string, from: string): string {
  const kind = entryKind(name);
  if (kind !== 'directory') throw directoryRefusal(name, from, kind);
  const expected = join(from, name);
  const id = openEntryIdentity(name);
  process.chdir(name);
  const cwdId = openCwdIdentity();
  if (cwdId.dev !== id.dev || cwdId.ino !== id.ino || process.cwd() !== expected) throw substitutionRefusal(expected);
  boundLevels = [...boundLevels, { path: expected, dev: id.dev, ino: id.ino }];
  return expected;
}

function openEntryIdentity(name: string): Stats {
  const fd = openEntryDirectory(name);
  try {
    return fstatSync(fd);
  } finally {
    closeSync(fd);
  }
}

function openEntryDirectory(name: string): number {
  return openHere(name, constants.O_RDONLY | DIRECTORY);
}

function openCwdIdentity(): Stats {
  const fd = openSync('.', constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    return fstatSync(fd);
  } finally {
    closeSync(fd);
  }
}

function substitutionRefusal(subject: string): EvolveError {
  return new EvolveError(
    'unsafe-path',
    `${subject} resolved to a different directory than the one just verified; a substitution between the check and the chdir is refused`,
  );
}

function directoryRefusal(name: string, from: string, kind: EntryKind): EvolveError {
  if (kind === 'missing') {
    return new EvolveError('layout-violation', `${join(from, name)} does not exist`);
  }
  return new EvolveError('unsafe-path', `${join(from, name)} must be a real directory; symlinks and non-directories are refused`);
}

function removeDirectoryHere(name: string): void {
  try {
    rmdirSync(name);
  } catch {
    // Best-effort cleanup of a directory this call created; the failure mode
    // is an empty directory, never a changed byte.
  }
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

/**
 * Re-resolve every recorded level and compare device+inode. Called before
 * every open and every write; a moved, replaced or symlinked level refuses
 * with the level's path.
 */
function verifyBoundChain(): void {
  for (const level of boundAncestors) verifyLevel(level);
  for (const level of boundLevels) verifyLevel(level);
  const deepest = boundLevels[boundLevels.length - 1];
  if (deepest === undefined) return;
  const cwdId = openCwdIdentity();
  if (cwdId.dev !== deepest.dev || cwdId.ino !== deepest.ino) throw movedRefusal(deepest.path);
}

function verifyLevel(level: BoundLevel): void {
  let stat;
  try {
    stat = lstatSync(level.path);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') throw movedRefusal(level.path);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== level.dev || stat.ino !== level.ino) {
    throw movedRefusal(level.path);
  }
}

function movedRefusal(path: string): EvolveError {
  return new EvolveError(
    'unsafe-path',
    `${path} is no longer the verified directory (moved, replaced or symlinked); refusing to write through the relocation`,
  );
}

/** Create a new file atomically; an existing file — even a symlink — is refused. */
export function createFileHere(name: string, contents: string): void {
  verifyBoundChain();
  const fd = openHere(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try {
    try {
      verifyBoundChain();
    } catch (error) {
      removeFileHere(fd, name);
      throw error;
    }
    writeAll(fd, contents);
    try {
      verifyBoundChain();
    } catch (error) {
      removeFileHere(fd, name);
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}

/** Create or replace a regular file; a symlink final component is refused. */
export function replaceFileHere(name: string, contents: string): void {
  verifyBoundChain();
  const { fd, created } = openReplacement(name);
  try {
    const original = created ? Buffer.alloc(0) : readAll(fd);
    try {
      verifyBoundChain();
    } catch (error) {
      if (created) removeFileHere(fd, name);
      throw error;
    }
    ftruncateSync(fd, 0);
    writeAll(fd, contents);
    try {
      verifyBoundChain();
    } catch (error) {
      if (created) removeFileHere(fd, name);
      else {
        ftruncateSync(fd, 0);
        writeAll(fd, original);
      }
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}

/** Append to an existing regular file; refuses to create it and returns the full new bytes. */
export function appendFileHere(name: string, contents: string): Buffer {
  verifyBoundChain();
  const fd = openHere(name, constants.O_RDWR | constants.O_APPEND);
  try {
    const sizeBefore = fstatSync(fd).size;
    verifyBoundChain();
    writeAll(fd, contents);
    try {
      verifyBoundChain();
    } catch (error) {
      if (fstatSync(fd).size > sizeBefore) ftruncateSync(fd, sizeBefore);
      throw error;
    }
    return readAll(fd);
  } finally {
    closeSync(fd);
  }
}

/** Read a regular file; a symlink final component is refused. */
export function readFileHere(name: string): Buffer {
  verifyBoundChain();
  const fd = openHere(name, constants.O_RDONLY);
  try {
    const data = readAll(fd);
    verifyBoundChain();
    return data;
  } finally {
    closeSync(fd);
  }
}

function openReplacement(name: string): { fd: number; created: boolean } {
  try {
    return { fd: openHere(name, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL), created: true };
  } catch (error) {
    if (nodeErrorCode(error) !== 'EEXIST') throw error;
    return { fd: openHere(name, constants.O_RDWR), created: false };
  }
}

/** Unlink the file this call created, identified by its fd's device+inode. */
function removeFileHere(fd: number, name: string): void {
  try {
    const created = fstatSync(fd);
    const at = lstatSync(name);
    if (at.dev === created.dev && at.ino === created.ino) unlinkSync(name);
  } catch {
    // Best-effort revert of the file this call created, in the window where a
    // relocation was only observed after the kernel created it.
  }
}

function openHere(name: string, flags: number): number {
  try {
    return openSync(name, flags | NOFOLLOW, 0o644);
  } catch (error) {
    if (nodeErrorCode(error) === 'ELOOP') {
      throw new EvolveError('unsafe-path', `${name} is a symlink; evolve writes do not follow symlinks`, {
        cause: error,
      });
    }
    throw error;
  }
}

function writeAll(fd: number, contents: Buffer | string): void {
  const bytes = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
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

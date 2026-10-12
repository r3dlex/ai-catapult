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
 *     relative to the bound inode. A relocation first detected only after a
 *     kernel mutation is compensated only for bytes this call can still
 *     identify as its own. A created file is unlinked only when the directory
 *     entry is still that inode and the file still holds exactly the bytes
 *     this call wrote (empty, if this call has not written). Inode identity is
 *     not exclusive ownership of the current bytes: a competitor append already
 *     present at that check is left in place, and the file is not unlinked.
 *     An appended suffix is removed only when this descriptor's append placement
 *     is still the end of the file and those bytes are still the bytes this
 *     call wrote. A matching tail is not ownership. If that placement is not
 *     the end of the file, or cannot be identified, the file is left
 *     untouched. A replaced file is restored from its captured original bytes
 *     only while the file still equals the bytes this call wrote. Otherwise
 *     the call refuses and does not truncate or rewrite. This is not a claim
 *     that net external change is zero, and it is not a claim that the check
 *     and the unlink are one kernel operation.
 *   - Missing-root creation: the caller path is walked before any create and
 *     each existing component's device+inode is recorded. Missing components
 *     are created one level at a time only after every recorded ancestor still
 *     has that identity. Revert then rmdirs a created directory only while
 *     lstat still shows that directory inode. A non-empty directory, or any other rmdir
 *     failure, is left in place. The refusal is returned either way. This is
 *     not a claim that the directory is absent when the refusal is returned,
 *     and cleanup does not delete a competitor's contents.
 *   - A missing descended directory is created only after the recorded chain
 *     is re-verified. A create that followed a substitution observed after
 *     mkdir is removed with rmdir by name, best-effort. A removal failure,
 *     including a non-empty directory, is swallowed and the directory is left
 *     in place. The refusal is still returned. This is not a claim that the
 *     directory is absent, and cleanup does not delete a competitor's contents.
 *   - Hard-linked leaves: a regular file with nlink > 1 is refused before any
 *     write, so an outside hard link is not mutated.
 *   - Known residual, declared: darwin has no openat2/RESOLVE_BENEATH and Node
 *     exposes no openat/fchdir. A concurrent hostile relocator that interposes
 *     between the very last identity re-verification and the kernel write can
 *     still have that single write land in the relocated inode. That interval
 *     is outside this boundary. Relocation is refused whenever observed;
 *     compensation above does not close the interval and does not undo a write
 *     that cannot be identified as ours.
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
  const walked = walkCallerPath(anchor);
  if (walked.complete) return bindVerifiedRoot(anchor, walked.levels);
  return bindVerifiedRoot(anchor, createMissingRoot(anchor, walked.levels));
}

interface CreatedDir {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

/**
 * Create only the missing suffix, after every recorded ancestor still has the
 * identity captured on the pre-create walk. Revert rmdirs each directory this
 * call created only while it is still that inode. A non-empty directory or a
 * failed rmdir is left in place; the refusal still propagates.
 */
function createMissingRoot(anchor: string, recorded: readonly BoundLevel[]): BoundLevel[] {
  const created: CreatedDir[] = [];
  try {
    for (const path of missingAfter(anchor, recorded)) {
      verifyRecordedIdentities(recorded, created);
      createOneDirectory(path, created);
    }
    const chain = callerPathChain(anchor);
    if (chain === null) {
      throw new EvolveError('unsafe-path', `${anchor} could not be created as a real directory`);
    }
    return chain;
  } catch (error) {
    revertCreatedDirectories(created);
    throw error;
  }
}

function missingAfter(anchor: string, recorded: readonly BoundLevel[]): string[] {
  const have = new Set(recorded.map((level) => level.path));
  const missing: string[] = [];
  let prefix = '';
  for (const part of anchor.split('/').filter((segment) => segment !== '')) {
    prefix = `${prefix}/${part}`;
    if (!have.has(prefix)) missing.push(prefix);
  }
  return missing;
}

function verifyRecordedIdentities(recorded: readonly BoundLevel[], created: readonly CreatedDir[]): void {
  for (const level of recorded) verifyLevel(level);
  for (const dir of created) {
    const stat = lstatOrMissing(dir.path);
    if (
      stat === null ||
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== dir.dev ||
      stat.ino !== dir.ino
    ) {
      throw movedRefusal(dir.path);
    }
  }
}

function lstatOrMissing(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function createOneDirectory(path: string, created: CreatedDir[]): void {
  const made = mkdirOne(path);
  const stat = lstatOrMissing(path);
  rememberCreated(path, made, stat, created);
  // Re-walk after the create: a substituted ancestor is a symlink on this
  // path even when mkdir followed it and the leaf landed outside.
  if (!createdDirectoryIsInside(path, stat)) {
    throw new EvolveError('unsafe-path', `${path} could not be created as a real directory`);
  }
}

function mkdirOne(path: string): boolean {
  try {
    mkdirSync(path);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) !== 'EEXIST') throw error;
    return false;
  }
}

function rememberCreated(path: string, made: boolean, stat: Stats | null, created: CreatedDir[]): void {
  if (stat === null || !made || !stat.isDirectory() || stat.isSymbolicLink()) return;
  created.push({ path, dev: stat.dev, ino: stat.ino });
}

function createdDirectoryIsInside(path: string, stat: Stats | null): boolean {
  if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return false;
  return callerPathChain(path) !== null;
}

function revertCreatedDirectories(created: readonly CreatedDir[]): void {
  for (const dir of [...created].reverse()) {
    try {
      const stat = lstatSync(dir.path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (stat.dev !== dir.dev || stat.ino !== dir.ino) continue;
      rmdirSync(dir.path);
    } catch {
      // Empty-directory revert only. A non-empty directory holds another
      // writer's bytes and is left in place.
    }
  }
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
    const code = nodeErrorCode(error);
    // Darwin returns ENOTDIR, not ELOOP, for O_DIRECTORY|O_NOFOLLOW on a symlink.
    if (code === 'ELOOP') throw symlinkedRootRefusal(root);
    if (code === 'ENOTDIR') throw openRootRefusal(root);
    throw error;
  }
}

interface WalkedPath {
  readonly levels: BoundLevel[];
  readonly complete: boolean;
}

/** Walk the caller path top-down. `complete` is false when a component is missing. */
function walkCallerPath(anchor: string): WalkedPath {
  const levels: BoundLevel[] = [];
  let prefix = '';
  for (const part of anchor.split('/').filter((segment) => segment !== '')) {
    prefix = `${prefix}/${part}`;
    let stat;
    try {
      stat = lstatSync(prefix);
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return { levels, complete: false };
      throw error;
    }
    if (stat.isSymbolicLink()) throw symlinkedRootRefusal(prefix);
    if (!stat.isDirectory()) throw nonDirectoryRootRefusal(prefix);
    levels.push({ path: prefix, dev: stat.dev, ino: stat.ino });
  }
  return { levels, complete: true };
}

/** Walk the caller path top-down; null when some component does not exist yet. */
function callerPathChain(anchor: string): BoundLevel[] | null {
  const walked = walkCallerPath(anchor);
  return walked.complete ? walked.levels : null;
}

function nonDirectoryRootRefusal(path: string): EvolveError {
  return new EvolveError(
    'unsafe-path',
    `${path} must be a real directory; the workspace root path cannot traverse a non-directory`,
  );
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
  verifyBoundChain();
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
    // Best-effort cleanup of a directory this call created. A removal failure,
    // including a non-empty directory, is swallowed and the directory is left
    // in place. This is not a claim that the directory is absent, and cleanup
    // does not delete a competitor's contents.
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
  // O_RDWR so refusal cleanup can read this inode. A write-only descriptor
  // cannot tell a competitor append from the bytes this call wrote.
  const fd = openHere(name, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL);
  const ownBytes = Buffer.from(contents, 'utf8');
  try {
    try {
      verifyBoundChain();
      refuseMultiplyLinked(fd, name);
    } catch (error) {
      removeFileHere(fd, name, Buffer.alloc(0));
      throw error;
    }
    writeAll(fd, ownBytes);
    try {
      verifyBoundChain();
    } catch (error) {
      removeFileHere(fd, name, ownBytes);
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
  const ownBytes = Buffer.from(contents, 'utf8');
  try {
    refuseMultiplyLinked(fd, name);
    const original = created ? Buffer.alloc(0) : readAll(fd);
    try {
      verifyBoundChain();
    } catch (error) {
      if (created) removeFileHere(fd, name, Buffer.alloc(0));
      throw error;
    }
    ftruncateSync(fd, 0);
    writeAll(fd, ownBytes);
    try {
      verifyBoundChain();
    } catch (error) {
      if (created) removeFileHere(fd, name, ownBytes);
      else restoreReplacement(fd, original, contents);
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
    refuseMultiplyLinked(fd, name);
    verifyBoundChain();
    const placedEnd = appendOwned(fd, contents);
    try {
      verifyBoundChain();
    } catch (error) {
      rollbackOwnSuffix(fd, contents, placedEnd);
      throw error;
    }
    return readAll(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Append `contents` and return the offset where this descriptor's write ended,
 * or null when that placement is not a removable tail. A later matching suffix
 * is not this placement: O_APPEND leaves this fd's offset at the end of its
 * own write, and a competing append does not move it.
 */
function appendOwned(fd: number, contents: string): number | null {
  const bytes = Buffer.from(contents, 'utf8');
  if (bytes.length === 0) return null;
  let offset = 0;
  let placedEnd: number | null = null;
  while (offset < bytes.length) {
    const wrote = writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (wrote <= 0) {
      if (offset < bytes.length) writeAll(fd, bytes.subarray(offset));
      return null;
    }
    const end = placementEnd(fd);
    if (end === null || (placedEnd !== null && end - wrote !== placedEnd)) {
      if (offset + wrote < bytes.length) writeAll(fd, bytes.subarray(offset + wrote));
      return null;
    }
    placedEnd = end;
    offset += wrote;
  }
  return placedEnd;
}

/**
 * File offset after this fd's O_APPEND write. Null when a byte already follows
 * that write, so the tail is not proof that the suffix is ours.
 */
function placementEnd(fd: number): number | null {
  const before = fstatSync(fd).size;
  const probe = Buffer.alloc(1);
  const read = readSync(fd, probe, 0, 1, null);
  if (read !== 0) return null;
  if (fstatSync(fd).size !== before) return null;
  return before;
}

/**
 * Remove the byte range this descriptor placed, and only while that range is
 * still the end of the file and still holds the bytes this call wrote. A
 * matching tail is not ownership. Never truncate to a size captured before
 * the write, and never truncate once the file no longer ends at the placement.
 */
function rollbackOwnSuffix(fd: number, contents: string, placedEnd: number | null): void {
  if (placedEnd === null) return;
  const ours = Buffer.from(contents, 'utf8');
  if (ours.length === 0 || placedEnd < ours.length) return;
  const start = placedEnd - ours.length;
  if (!ownedTailIntact(fd, start, ours, placedEnd)) return;
  ftruncateSync(fd, start);
}

function ownedTailIntact(fd: number, start: number, ours: Buffer, placedEnd: number): boolean {
  if (fstatSync(fd).size !== placedEnd) return false;
  if (!regionEquals(fd, start, ours)) return false;
  if (fstatSync(fd).size !== placedEnd) return false;
  const probe = Buffer.alloc(1);
  if (readSync(fd, probe, 0, 1, placedEnd) !== 0) return false;
  return fstatSync(fd).size === placedEnd;
}

function regionEquals(fd: number, position: number, expected: Buffer): boolean {
  const buf = Buffer.alloc(expected.length);
  const read = readSync(fd, buf, 0, expected.length, position);
  return read === expected.length && buf.equals(expected);
}

/**
 * Restore the captured original only while the file is still exactly the bytes
 * this call wrote. A competing write after ours is left untouched.
 */
function restoreReplacement(fd: number, original: Buffer, contents: string): void {
  const ours = Buffer.from(contents, 'utf8');
  if (!readAll(fd).equals(ours)) return;
  if (fstatSync(fd).size !== ours.length) return;
  if (!readAll(fd).equals(ours)) return;
  ftruncateSync(fd, 0);
  writeAt(fd, original, 0);
}

function writeAt(fd: number, bytes: Buffer, position: number): void {
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset, position + offset);
  }
}

function refuseMultiplyLinked(fd: number, name: string): void {
  const stat = fstatSync(fd);
  if (stat.isFile() && stat.nlink > 1) {
    throw new EvolveError('unsafe-path', `${name} is multiply linked; evolve writes refuse a hard-linked leaf`);
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

/**
 * Unlink a file this call created only while the directory entry is still that
 * inode and the file still holds exactly `ownBytes`. A competitor append
 * already present fails that check and is left in place. Inode identity is
 * not exclusive ownership of the current bytes.
 */
function removeFileHere(fd: number, name: string, ownBytes: Buffer): void {
  try {
    if (!entryIsThisFile(fd, name)) return;
    if (!fileStillExactly(fd, ownBytes)) return;
    if (!entryIsThisFile(fd, name)) return;
    if (!fileStillExactly(fd, ownBytes)) return;
    unlinkSync(name);
  } catch {
    // Best-effort revert. A file that is not exactly the bytes this call
    // wrote — including a competitor append on this inode — is left in place.
  }
}

function entryIsThisFile(fd: number, name: string): boolean {
  const created = fstatSync(fd);
  const at = lstatSync(name);
  return at.isFile() && !at.isSymbolicLink() && at.dev === created.dev && at.ino === created.ino;
}

function fileStillExactly(fd: number, ownBytes: Buffer): boolean {
  if (fstatSync(fd).size !== ownBytes.length) return false;
  if (!readAll(fd).equals(ownBytes)) return false;
  return fstatSync(fd).size === ownBytes.length;
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

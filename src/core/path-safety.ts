import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { SafetyError } from "./errors.js";

export interface PathBoundary {
  target: string;
  boundary: string;
}

/**
 * Resolves a path lexically and rejects traversal outside the requested root.
 * Canonical checks must still be used before filesystem I/O because symlinks
 * and Windows junctions can redirect an otherwise relative path.
 */
export function resolveContainedPath(
  rootDirectory: string,
  candidatePath: string,
  labels: PathBoundary,
): string {
  const absoluteRoot = resolve(rootDirectory);
  const absoluteCandidate = resolve(absoluteRoot, candidatePath);
  assertContained(absoluteRoot, absoluteCandidate, labels, "lexical");
  return absoluteCandidate;
}

/**
 * Resolves every existing component through the platform filesystem. Missing
 * suffixes are projected from the nearest canonical ancestor, so an existing
 * symlink, junction, or other reparse point cannot hide an escape.
 */
export async function canonicalizeContainedPath(
  rootDirectory: string,
  candidatePath: string,
  labels: PathBoundary,
): Promise<string> {
  const absoluteRoot = resolve(rootDirectory);
  const absoluteCandidate = resolveContainedPath(absoluteRoot, candidatePath, labels);
  const canonicalRoot = await realpath(absoluteRoot);
  const canonicalCandidate = await canonicalizeFromNearestExistingAncestor(absoluteCandidate);
  assertContained(canonicalRoot, canonicalCandidate, labels, "canonical");
  return canonicalCandidate;
}

/**
 * Checks canonical containment both before and after mkdir. mkdir operates on
 * the canonical projection rather than the untrusted alias, reducing the gap
 * in which a checked junction could redirect directory creation.
 */
export async function ensureContainedDirectory(
  rootDirectory: string,
  candidateDirectory: string,
  labels: PathBoundary,
): Promise<string> {
  const absoluteRoot = resolve(rootDirectory);
  const canonicalRoot = await realpath(absoluteRoot);
  const canonicalBefore = await canonicalizeContainedPath(absoluteRoot, candidateDirectory, labels);
  assertContained(canonicalRoot, canonicalBefore, labels, "canonical");
  await mkdir(canonicalBefore, { recursive: true });
  const canonicalAfter = await realpath(canonicalBefore);
  assertContained(canonicalRoot, canonicalAfter, labels, "canonical");
  return canonicalAfter;
}

async function canonicalizeFromNearestExistingAncestor(candidatePath: string): Promise<string> {
  let current = candidatePath;
  const missingSegments: string[] = [];
  for (;;) {
    try {
      const canonicalAncestor = await realpath(current);
      return resolve(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

function assertContained(
  rootDirectory: string,
  candidatePath: string,
  labels: PathBoundary,
  check: "lexical" | "canonical",
): void {
  const relativePath = relative(rootDirectory, candidatePath);
  const outside = relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
  if (!outside) return;
  throw new SafetyError(`Refusing ${labels.target} outside the ${labels.boundary}.`, {
    check,
    rootDirectory,
    candidatePath,
  });
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

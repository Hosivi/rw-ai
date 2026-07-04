import fs from 'node:fs/promises';
import path from 'node:path';
import type { Stack } from '../contract/schema.js';
import { detectDbSetup, type DbDetection } from './database.js';
import type { Git } from './git.js';

// ---------------------------------------------------------------------------
// Stack + project-name detection by marker files (existence only, no deep parse)
// ---------------------------------------------------------------------------

// The fixed order every consumer relies on: a multi-stack repo always reports
// its stacks in [node, android, dotnet] sequence.
const ANDROID_MARKERS = ['build.gradle', 'build.gradle.kts', 'settings.gradle'] as const;

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

// .NET has no single well-known filename: any *.csproj or *.sln at the root
// marks the stack, so we list the directory instead of probing fixed names.
const hasDotnetProject = async (projectRoot: string): Promise<boolean> => {
  let entries: string[];
  try {
    entries = await fs.readdir(projectRoot);
  } catch {
    return false;
  }
  return entries.some((name) => name.endsWith('.csproj') || name.endsWith('.sln'));
};

const hasAndroidProject = async (projectRoot: string): Promise<boolean> => {
  const hits = await Promise.all(
    ANDROID_MARKERS.map((marker) => fileExists(path.join(projectRoot, marker))),
  );
  return hits.some(Boolean);
};

// Detection is best-effort and existence-only: it never parses build files, so a
// malformed marker still counts as "this stack is present". Returns ALL detected
// stacks (a repo may be multi-stack) in the fixed [node, android, dotnet] order,
// or [] when none match — the caller decides the fallback.
export const detectStacks = async (projectRoot: string): Promise<Stack[]> => {
  const [hasNode, hasAndroid, hasDotnet] = await Promise.all([
    fileExists(path.join(projectRoot, 'package.json')),
    hasAndroidProject(projectRoot),
    hasDotnetProject(projectRoot),
  ]);
  const stacks: Stack[] = [];
  if (hasNode) {
    stacks.push('node');
  }
  if (hasAndroid) {
    stacks.push('android');
  }
  if (hasDotnet) {
    stacks.push('dotnet');
  }
  return stacks;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The project name: package.json's `name` when present and non-empty, otherwise
// the basename of the repo root. Best-effort — a missing or malformed
// package.json degrades to the basename rather than throwing.
export const detectProjectName = async (projectRoot: string): Promise<string> => {
  const fallback = path.basename(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8');
  } catch {
    return fallback;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed['name'] === 'string' && parsed['name'].trim() !== '') {
      return parsed['name'];
    }
  } catch {
    // Malformed JSON: fall through to the basename fallback.
  }
  return fallback;
};

// The conventional base-branch candidates, in preference order. Prefer a
// default that ACTUALLY EXISTS over a hardcoded guess: rw configure's
// integration-branch step requires git.baseBranch to exist, so scaffolding a
// non-existent branch (e.g. 'main' in a 'master' repo) makes configure fail
// immediately.
const BASE_BRANCH_CANDIDATES = ['main', 'master'] as const;

// Detects the repo's base branch: 'main' if it exists, else 'master' if it
// exists, else whatever HEAD currently points at, else 'main' as a last resort.
// Best-effort like detectProjectName — every git probe degrades to the next
// candidate rather than throwing, so onboarding never aborts on a branch probe.
export const detectBaseBranch = async (git: Git): Promise<string> => {
  for (const candidate of BASE_BRANCH_CANDIDATES) {
    const exists = await git.branchExists(candidate);
    if (exists.ok && exists.value) {
      return candidate;
    }
  }
  const current = await git.currentBranch();
  if (current.ok && current.value.trim() !== '') {
    return current.value;
  }
  return BASE_BRANCH_CANDIDATES[0];
};

// ---------------------------------------------------------------------------
// Whole-project detection
// ---------------------------------------------------------------------------

export type Detection = {
  readonly stacks: Stack[];
  readonly projectName: string;
  readonly db: DbDetection;
};

// A db detection that decided nothing: used when detectDbSetup itself fails so
// onboarding never aborts on a database probe error.
const NO_DB: DbDetection = { strategy: 'none', host: 'localhost', port: 5432, sources: [] };

// Runs stack, name and database detection together. db detection failure
// degrades to strategy 'none' rather than failing the whole detection — a repo
// with an unreadable compose file is still worth scaffolding.
export const detectProject = async (projectRoot: string): Promise<Detection> => {
  const [stacks, projectName, dbResult] = await Promise.all([
    detectStacks(projectRoot),
    detectProjectName(projectRoot),
    detectDbSetup(projectRoot),
  ]);
  return { stacks, projectName, db: dbResult.ok ? dbResult.value : NO_DB };
};

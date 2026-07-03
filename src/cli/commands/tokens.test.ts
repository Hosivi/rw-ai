import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBoardDir } from '../../contract/env.js';
import type { AgentsConfig } from '../../contract/schema.js';
import { writeAgentsConfig } from '../../engine/config-io.js';
import { buildConfig, createTempRepo, type TempRepo } from '../../engine/git.test-support.js';
import type { CliDeps } from '../command.js';
import { runConfigure } from './configure.js';
import { runTokens } from './tokens.js';

const NOW = new Date('2026-07-02T12:00:00.000Z');

// A representative pricing.json: sonnet is priced, so the default model resolves a
// cost; 'claude-opus-4-8' is intentionally omitted to exercise the "sin precio" path.
const PRICING = {
  _comment: 'valores indicativos, verifica con Anthropic',
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
};

describe('runTokens (offline estimate + pricing, through a real repo)', () => {
  let repo: TempRepo;
  let config: AgentsConfig;

  const deps = (env: Record<string, string | undefined> = {}): CliDeps => ({
    cwd: repo.root,
    homeDir: repo.root,
    env,
    now: NOW,
  });

  beforeAll(async () => {
    repo = await createTempRepo();
    config = buildConfig();
    await writeAgentsConfig(repo.root, config);
    const configured = await runConfigure(deps());
    expect(configured.exitCode).toBe(0);
    await fs.writeFile(path.join(repo.root, 'pricing.json'), JSON.stringify(PRICING));
  }, 60000);

  afterAll(async () => {
    await repo.cleanup();
  });

  it('estimates tokens and an input cost for a file, exit 0, and writes the report', async () => {
    // 400 chars -> ceil(400/4) = 100 tokens; sonnet input 3 USD/MTok -> 0.0003 USD.
    const sample = path.join(repo.root, 'sample.txt');
    await fs.writeFile(sample, 'a'.repeat(400));

    const result = await runTokens({ paths: [sample] }, deps());
    const text = result.lines.join('\n');
    expect(result.exitCode).toBe(0);
    expect(text).toContain('100 tokens');
    expect(text).toContain('US$');
    expect(text).toContain('ESTIMACIÓN');

    const reportPath = path.join(resolveBoardDir(repo.root, config), 'reports', 'tokens.md');
    expect(existsSync(reportPath)).toBe(true);
    const report = await fs.readFile(reportPath, 'utf8');
    expect(report).toContain('claude-sonnet-5');
  });

  it('reports "sin precio" for a model absent from pricing.json, still exit 0', async () => {
    const sample = path.join(repo.root, 'sample-opus.txt');
    await fs.writeFile(sample, 'hello world');

    const result = await runTokens({ paths: [sample], model: 'claude-opus-4-8' }, deps());
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('sin precio');
  });

  it('defaults to the review board directory when no paths are given', async () => {
    const result = await runTokens({}, deps());
    expect(result.exitCode).toBe(0);
    // The board holds at least board.md + per-session task files: some tokens counted.
    expect(result.lines.join('\n')).toContain('Total:');
  });

  it('exits 1 for --online without ANTHROPIC_API_KEY in the environment', async () => {
    const sample = path.join(repo.root, 'sample-online.txt');
    await fs.writeFile(sample, 'hello');

    const result = await runTokens({ paths: [sample], online: true }, deps({}));
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('ANTHROPIC_API_KEY');
  });
});

describe('runTokens (missing pricing.json)', () => {
  let repo: TempRepo;

  const deps = (): CliDeps => ({ cwd: repo.root, homeDir: repo.root, env: {}, now: NOW });

  beforeAll(async () => {
    repo = await createTempRepo();
    await writeAgentsConfig(repo.root, buildConfig());
    // Deliberately NO pricing.json at the repo root.
  }, 60000);

  afterAll(async () => {
    await repo.cleanup();
  });

  it('exits 1 and points the user at pricing.json', async () => {
    const sample = path.join(repo.root, 'sample.txt');
    await fs.writeFile(sample, 'hello');

    const result = await runTokens({ paths: [sample] }, deps());
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('pricing.json');
  });
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveBoardDir } from '../../contract/env.js';
import { writeFileIdempotent } from '../../engine/board.js';
import {
  countTokensOnline,
  defaultPricingPath,
  estimateTokens,
  inputCostUsd,
  loadPricing,
  type Pricing,
} from '../../engine/tokens.js';
import type { CliDeps, CommandResult } from '../command.js';
import { loadContext } from '../context.js';
import { formatTokens, type FileTokens, type TokensSummary } from '../output.js';

// Default when the user does not pass --model. Matches the project's mid-tier model.
const DEFAULT_MODEL = 'claude-sonnet-5';

// The env var the online mode reads the Anthropic key from. Never logged/stored.
const API_KEY_ENV = 'ANTHROPIC_API_KEY';

// Skip a file that cannot be read (permissions, races) or that looks binary. The
// NUL-byte heuristic is intentionally simple: token estimation is meaningless on
// binaries (screenshots, videos in the board), so we drop them rather than crash.
const readTextFileSafe = async (filePath: string): Promise<string | undefined> => {
  let buf: Buffer;
  try {
    buf = await fs.readFile(filePath);
  } catch {
    return undefined;
  }
  if (buf.includes(0)) {
    return undefined;
  }
  return buf.toString('utf8');
};

// Expand a path into the concrete files to count: a file is itself, a directory is
// recursed. Entries are sorted by name for a deterministic order (localeCompare is
// locale-sensitive, so a plain comparison is used instead). Unreadable paths are
// skipped so one bad entry never aborts the whole run.
const collectFiles = async (target: string): Promise<string[]> => {
  let stats: import('node:fs').Stats;
  try {
    stats = await fs.stat(target);
  } catch {
    return [];
  }
  if (stats.isFile()) {
    return [target];
  }
  if (!stats.isDirectory()) {
    return [];
  }
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return [];
  }
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: string[] = [];
  for (const entry of sorted) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
};

// A usage failure asking for input paths: exit 2, mirroring the CLI's usage codes.
const usageNeedsPaths = (): CommandResult => ({
  lines: [
    'Indica al menos una ruta de archivo o directorio, o ejecuta rw tokens dentro de un repositorio rw configurado.',
  ],
  exitCode: 2,
});

// Pure, deterministic Spanish (tuteo) report for .review-board/reports/tokens.md.
// Same (summary, now) always yields the same markdown, so writeFileIdempotent skips
// a no-op rewrite. It restates the "verifica pricing.json" warning on purpose.
export const renderTokensReport = (summary: TokensSummary, now: Date): string => {
  const costLine =
    summary.costUsd === undefined
      ? 'sin precio (edita pricing.json)'
      : `US$ ${summary.costUsd.toFixed(6)}`;
  const modeLine =
    summary.mode === 'offline'
      ? 'Conteo ESTIMADO sin conexión (~4 caracteres por token). Para un conteo exacto usa `rw tokens --online`.'
      : 'Conteo exacto obtenido de la API de conteo de tokens de Anthropic.';
  const lines = [
    '# Tokens y costo',
    '',
    `Generado: ${now.toISOString()}`,
    '',
    `- Modelo: \`${summary.model}\``,
    `- Total: ${summary.totalTokens} tokens`,
    `- Costo estimado de entrada: ${costLine}`,
    '',
    `> ${modeLine}`,
    '> Los precios salen de `pricing.json`, que es editable y debes verificar contra la lista vigente de Anthropic.',
    '',
    '## Archivos',
    '',
    '| Archivo | Tokens |',
    '| --- | --- |',
    ...summary.files.map((file) => `| \`${file.path}\` | ${file.tokens} |`),
    '',
  ];
  return lines.join('\n');
};

// `rw tokens`: estimate (or exactly count) how many tokens — and how much money —
// a set of files costs to feed to Claude. OFFLINE by default (no network, no key);
// --online uses the Anthropic count_tokens API for an exact count. Prices come from
// an editable pricing.json resolved at the repo root.
export const runTokens = async (
  args: { paths?: string[]; model?: string; online?: boolean },
  deps: CliDeps,
): Promise<CommandResult> => {
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  const inRepo = context.ok;
  // Prices live next to the code the user runs against: their repo root inside a rw
  // repo, else the current directory. The bundled default (defaultPricingPath) is
  // only named in the error, never silently loaded, so a missing file stays visible.
  const base = inRepo ? context.value.projectRoot : deps.cwd;
  const pricingPath = path.join(base, 'pricing.json');

  const pricing = await loadPricing(pricingPath);
  if (!pricing.ok) {
    return {
      lines: [
        pricing.error.message,
        `Puedes tomar como base el archivo de referencia que trae rw: ${defaultPricingPath()}`,
      ],
      exitCode: 1,
    };
  }
  const priceMap: Pricing = pricing.value;

  const model = args.model ?? DEFAULT_MODEL;
  const online = args.online === true;

  // Resolve the inputs: explicit paths win; otherwise default to the review board
  // when in a rw repo, else demand paths.
  let inputPaths: string[];
  if (args.paths !== undefined && args.paths.length > 0) {
    inputPaths = args.paths;
  } else if (inRepo) {
    inputPaths = [resolveBoardDir(context.value.projectRoot, context.value.config)];
  } else {
    return usageNeedsPaths();
  }

  // Online mode needs a key from the environment; its absence is a hard stop with a
  // clear instruction rather than a silent fallback to the offline estimate.
  let apiKey: string | undefined;
  if (online) {
    apiKey = deps.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey.length === 0) {
      return {
        lines: [
          `El modo --online requiere la variable ${API_KEY_ENV} en el entorno. Expórtala y vuelve a intentar.`,
        ],
        exitCode: 1,
      };
    }
  }

  const files: FileTokens[] = [];
  for (const inputPath of inputPaths) {
    for (const filePath of await collectFiles(inputPath)) {
      const content = await readTextFileSafe(filePath);
      if (content === undefined) {
        continue;
      }
      if (online && apiKey !== undefined) {
        // fetch stays at this impure boundary (default globalThis.fetch); the engine
        // keeps it injectable so its own tests never touch the network.
        const counted = await countTokensOnline({ text: content, model, apiKey });
        if (!counted.ok) {
          return { lines: [counted.error.message], exitCode: 1 };
        }
        files.push({ path: filePath, tokens: counted.value });
      } else {
        files.push({ path: filePath, tokens: estimateTokens(content) });
      }
    }
  }

  const totalTokens = files.reduce((sum, file) => sum + file.tokens, 0);
  const summary: TokensSummary = {
    files,
    totalTokens,
    model,
    costUsd: inputCostUsd(totalTokens, model, priceMap),
    mode: online ? 'online' : 'offline',
  };

  // Persist the report only in a rw repo (that is where the board lives). The
  // reports dir is created defensively so `rw tokens` works even before configure.
  if (inRepo) {
    const boardDir = resolveBoardDir(context.value.projectRoot, context.value.config);
    const reportsDir = path.join(boardDir, 'reports');
    try {
      await fs.mkdir(reportsDir, { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { lines: [`No se pudo preparar ${reportsDir}: ${message}`], exitCode: 1 };
    }
    const written = await writeFileIdempotent(
      path.join(reportsDir, 'tokens.md'),
      renderTokensReport(summary, deps.now),
    );
    if (!written.ok) {
      return { lines: [written.error.message], exitCode: 1 };
    }
  }

  return { lines: formatTokens(summary).split('\n'), exitCode: 0 };
};

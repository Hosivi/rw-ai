import { assertNever } from '../../core/assert.js';
import {
  analyzeIntegration,
  writeIntegrationReport,
  type IntegrationAnalysis,
  type IntegratorError,
} from '../../engine/integrator.js';
import { contextErrorResult, type CliDeps, type CommandResult } from '../command.js';
import { loadContext } from '../context.js';
import { formatIntegration } from '../output.js';

const describeIntegratorError = (error: IntegratorError): string => {
  switch (error.kind) {
    case 'integration-branch-missing':
      return `No existe la rama de integración: ${error.message}. Ejecuta 'rw configure' primero.`;
    case 'session-branch-missing':
      return `Falta una rama de sesión: ${error.message}. Ejecuta 'rw configure'.`;
    case 'git':
      return `Error de git al analizar la integración: ${error.message}`;
    case 'io':
      return `Error de entrada/salida al escribir el reporte: ${error.message}`;
    default:
      return assertNever(error.kind);
  }
};

// A blocking state for the pre-merge gate: any simulated conflict, or any file a
// session wrote outside its lane. Shared-zone touches and plain overlaps are
// informational, not blocking. Exported so the gate contract CI relies on is
// unit-tested directly, not only through the full runCheck integration.
export const isBlocking = (analysis: IntegrationAnalysis): boolean =>
  analysis.invasions.length > 0 ||
  analysis.simulatedMerges.some((merge) => merge.status === 'conflict');

// `rw check`: analyze the real git state, write the integration report, and act
// as a pre-merge gate — exit 1 when there is anything blocking so it can fail CI.
export const runCheck = async (deps: CliDeps): Promise<CommandResult> => {
  const context = await loadContext(deps.cwd, deps.run, deps.runRaw);
  if (!context.ok) {
    return contextErrorResult(context.error);
  }
  const { config, projectRoot } = context.value;
  const analysis = await analyzeIntegration(config, projectRoot, deps.run, deps.runRaw);
  if (!analysis.ok) {
    return { lines: [describeIntegratorError(analysis.error)], exitCode: 1 };
  }
  const lines = formatIntegration(analysis.value).split('\n');

  // A failed report write must not hide the analysis the user asked for: surface
  // it as a warning and still fail the gate so nothing merges on a broken run.
  const written = await writeIntegrationReport(config, projectRoot, analysis.value, deps.now);
  if (!written.ok) {
    return { lines: [...lines, `Advertencia: ${describeIntegratorError(written.error)}`], exitCode: 1 };
  }
  const blocking = isBlocking(analysis.value);
  if (blocking) {
    lines.push('Hay conflictos o invasiones de carril: resuélvelos antes de integrar.');
  }
  return { lines, exitCode: blocking ? 1 : 0 };
};

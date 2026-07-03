import * as clack from '@clack/prompts';
import { err, ok, type Result } from '../core/result.js';
import type { RoleStatus } from '../engine/identity.js';
import { roleStatusLabel } from './output.js';

// The thin interactive layer. It is inherently I/O, so it stays small: the only
// testable logic is the non-interactive degradation, driven by an injectable
// `interactive` seam rather than a real TTY.

export type PromptError = {
  readonly kind: 'cancelled' | 'non-interactive';
  readonly message: string;
};

// Interactive only when BOTH streams are a TTY: a piped stdin (CI, scripts) or a
// redirected stdout must never block waiting on a prompt no one can answer.
export const isInteractive = (): boolean =>
  Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);

const nonInteractive = (action: string): PromptError => ({
  kind: 'non-interactive',
  message: `No hay terminal interactiva para ${action}. Usa las banderas correspondientes.`,
});

// clack.isCancel narrows the returned symbol; both prompts route it to the same
// 'cancelled' error so callers treat Ctrl-C uniformly.
const CANCELLED: PromptError = { kind: 'cancelled', message: 'Operación cancelada.' };

// Picks a role interactively. Non-interactive callers get a 'non-interactive'
// error so the command can fall back to requiring a --role flag. Occupied roles
// stay selectable (a claim may be expired or reclaimable) but are annotated.
export const selectRole = async (
  roles: readonly RoleStatus[],
  interactive: boolean = isInteractive(),
): Promise<Result<string, PromptError>> => {
  if (!interactive) {
    return err(nonInteractive('elegir un rol'));
  }
  const selected = await clack.select<string>({
    message: 'Elegí un rol para reclamar',
    options: roles.map((role) => ({
      value: role.role,
      label: `${role.role} — ${roleStatusLabel(role)}`,
    })),
  });
  if (clack.isCancel(selected)) {
    return err(CANCELLED);
  }
  return ok(selected);
};

// Asks whether E2E is needed for a platform. Non-interactive callers get a
// 'non-interactive' error so the command can require an explicit flag instead.
export const confirmE2E = async (
  platformLabel: string,
  interactive: boolean = isInteractive(),
): Promise<Result<boolean, PromptError>> => {
  if (!interactive) {
    return err(nonInteractive('confirmar E2E'));
  }
  const answer = await clack.confirm({ message: `¿Necesitas E2E para ${platformLabel}?` });
  if (clack.isCancel(answer)) {
    return err(CANCELLED);
  }
  return ok(answer);
};

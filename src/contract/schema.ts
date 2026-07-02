import { z } from 'zod';
import { err, ok, type Result } from '../core/result.js';

export const stackSchema = z.enum(['node', 'android', 'dotnet']);
export type Stack = z.infer<typeof stackSchema>;

export const dbStrategySchema = z.enum(['docker', 'local', 'supabase', 'none']);
export type DbStrategy = z.infer<typeof dbStrategySchema>;

export const platformIdSchema = z.enum(['web', 'mobile', 'native', 'dotnet']);
export type PlatformId = z.infer<typeof platformIdSchema>;

export const webE2eFrameworkSchema = z.enum(['playwright']);
export const mobileE2eFrameworkSchema = z.enum(['maestro', 'detox']);
export const nativeE2eFrameworkSchema = z.enum(['compose', 'paparazzi', 'roborazzi']);
export const dotnetE2eFrameworkSchema = z.enum(['playwright-dotnet']);

// E2E is opt-in per platform: enabling it without naming a framework leaves
// nothing to run, so the pair is validated together.
const e2eConfigSchema = <F extends z.ZodType<string>>(framework: F) =>
  z
    .object({
      enabled: z.boolean(),
      framework: framework.optional(),
    })
    .superRefine((e2e, ctx) => {
      if (e2e.enabled && e2e.framework === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'framework is required when e2e is enabled',
          path: ['framework'],
        });
      }
    });

const platformConfig = <F extends z.ZodType<string>>(framework: F) =>
  z.object({
    enabled: z.boolean(),
    e2e: e2eConfigSchema(framework),
  });

export const platformConfigSchemas = {
  web: platformConfig(webE2eFrameworkSchema),
  mobile: platformConfig(mobileE2eFrameworkSchema),
  native: platformConfig(nativeE2eFrameworkSchema),
  dotnet: platformConfig(dotnetE2eFrameworkSchema),
} as const;

export const sessionPlatformsSchema = z.object({
  web: platformConfigSchemas.web.optional(),
  mobile: platformConfigSchemas.mobile.optional(),
  native: platformConfigSchemas.native.optional(),
  dotnet: platformConfigSchemas.dotnet.optional(),
});
export type SessionPlatforms = z.infer<typeof sessionPlatformsSchema>;
export type PlatformConfig = NonNullable<SessionPlatforms[PlatformId]>;

// Single source of truth for the port bands rw-ai manages; PORT_BANDS in
// defaults.ts and the env var mapping in env.ts are type-locked to these names.
export const PORT_BAND_NAMES = ['api', 'web', 'metro'] as const;
export type PortBandName = (typeof PORT_BAND_NAMES)[number];

// App ports must be non-privileged (>= 1024).
const portNumberSchema = z.number().int().min(1024).max(65535);

export const portsSchema = z.object({
  api: portNumberSchema.optional(),
  web: portNumberSchema.optional(),
  metro: portNumberSchema.optional(),
});
export type Ports = z.infer<typeof portsSchema>;

const sessionIdPattern = /^s[1-9][0-9]*$/;
export const sessionIdSchema = z.string().regex(sessionIdPattern);

const isAbsolutePathLike = (value: string): boolean =>
  value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value);

export const sessionSchema = z.object({
  id: sessionIdSchema,
  branch: z.string().min(1),
  // Relative to the repo root: consumers join it themselves, so an absolute
  // path here would silently escape the project.
  worktree: z
    .string()
    .min(1)
    .refine((value) => !isAbsolutePathLike(value), {
      message: 'worktree must be a relative path',
    }),
  status: z.enum(['active', 'archived']),
  areas: z.array(z.string().min(1)).min(1),
  ports: portsSchema.optional(),
  db: z.object({ name: z.string().min(1) }).optional(),
  platforms: sessionPlatformsSchema.default({}),
});
export type Session = z.infer<typeof sessionSchema>;

// NO password field by design: secrets live only in the environment at
// runtime, never in agents.config.json.
export const dbSchema = z
  .object({
    strategy: dbStrategySchema,
    service: z.string().min(1).optional(),
    host: z.string().min(1).default('localhost'),
    // Floor of 1, not 1024: a managed/remote Postgres can expose any port,
    // unlike the app ports we allocate ourselves.
    port: z.number().int().min(1).max(65535).default(5432),
    user: z.string().min(1).optional(),
  })
  .superRefine((db, ctx) => {
    if (db.strategy === 'docker' && db.service === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: "service (container service name) is required when strategy is 'docker'",
        path: ['service'],
      });
    }
  });
export type DbConfig = z.infer<typeof dbSchema>;
// Input shape (defaults still optional) — for builders that feed the schema.
export type DbConfigInput = z.input<typeof dbSchema>;

export const gitConfigSchema = z.object({
  baseBranch: z.string().min(1).default('main'),
  integrationBranch: z.string().min(1).default('develop'),
  worktreesDir: z.string().min(1).default('.worktrees'),
});
export type GitConfig = z.infer<typeof gitConfigSchema>;

export const testsConfigSchema = z.object({
  captureScreenshots: z.boolean().default(true),
  captureVideo: z.boolean().default(false),
});
export type TestsConfig = z.infer<typeof testsConfigSchema>;

const findDuplicates = (
  ctx: z.RefinementCtx,
  entries: ReadonlyArray<{ value: string | number; path: Array<string | number> }>,
  label: string,
): void => {
  const seen = new Set<string | number>();
  for (const entry of entries) {
    if (seen.has(entry.value)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate ${label}: ${entry.value}`,
        path: entry.path,
      });
    }
    seen.add(entry.value);
  }
};

export const agentsConfigSchema = z
  .object({
    version: z.literal(1),
    project: z.object({
      name: z.string().min(1),
      stacks: z.array(stackSchema).min(1),
    }),
    git: gitConfigSchema.default({
      baseBranch: 'main',
      integrationBranch: 'develop',
      worktreesDir: '.worktrees',
    }),
    board: z
      .object({ dir: z.string().min(1).default('.review-board') })
      .default({ dir: '.review-board' }),
    db: dbSchema.default({ strategy: 'none', host: 'localhost', port: 5432 }),
    sharedZones: z.array(z.string().min(1)).default([]),
    tests: testsConfigSchema.default({ captureScreenshots: true, captureVideo: false }),
    sessions: z.array(sessionSchema),
  })
  .superRefine((config, ctx) => {
    findDuplicates(
      ctx,
      config.sessions.map((session, i) => ({ value: session.id, path: ['sessions', i, 'id'] })),
      'session id',
    );
    findDuplicates(
      ctx,
      config.sessions.map((session, i) => ({
        value: session.branch,
        path: ['sessions', i, 'branch'],
      })),
      'branch',
    );
    findDuplicates(
      ctx,
      config.sessions.map((session, i) => ({
        value: session.worktree,
        path: ['sessions', i, 'worktree'],
      })),
      'worktree',
    );
    findDuplicates(
      ctx,
      config.sessions.flatMap((session, i) =>
        session.db === undefined
          ? []
          : [{ value: session.db.name, path: ['sessions', i, 'db', 'name'] }],
      ),
      'db name',
    );
    // Port numbers must be unique across ALL sessions and ALL bands: two
    // sessions sharing any port cannot run in parallel.
    findDuplicates(
      ctx,
      config.sessions.flatMap((session, i) =>
        session.ports === undefined
          ? []
          : PORT_BAND_NAMES.flatMap((band) => {
              const port = session.ports?.[band];
              return port === undefined
                ? []
                : [{ value: port, path: ['sessions', i, 'ports', band] }];
            }),
      ),
      'port',
    );
  });
export type AgentsConfig = z.infer<typeof agentsConfigSchema>;

export const roleIdSchema = z.union([sessionIdSchema, z.literal('integrator')]);
export type RoleId = z.infer<typeof roleIdSchema>;

export const agentKindSchema = z.enum(['claude-code', 'opencode', 'human']);
export type AgentKind = z.infer<typeof agentKindSchema>;

// Long enough that concurrent agents cannot trivially collide or guess each
// other's token; claims are cooperative locking, not a security boundary.
export const MIN_CLAIM_TOKEN_LENGTH = 8;

// Claim values stay in English in code and on disk; Spanish (libre/ocupado)
// is presentation-layer only, applied later by the CLI.
export const claimSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('free') }),
  z.object({
    status: z.literal('claimed'),
    token: z.string().min(MIN_CLAIM_TOKEN_LENGTH),
    claimedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    agent: agentKindSchema.optional(),
  }),
]);
export type Claim = z.infer<typeof claimSchema>;

export const claimsFileSchema = z.object({
  version: z.literal(1),
  claims: z.record(roleIdSchema, claimSchema),
});
export type ClaimsFile = z.infer<typeof claimsFileSchema>;

export type ContractError = {
  message: string;
  issues: string[];
};

export const contractError = (message: string, issues: string[] = []): ContractError => ({
  message,
  issues,
});

const toContractError = (message: string, error: z.ZodError): ContractError =>
  contractError(
    message,
    error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
      return `${path}: ${issue.message}`;
    }),
  );

export const parseAgentsConfig = (input: unknown): Result<AgentsConfig, ContractError> => {
  const parsed = agentsConfigSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err(toContractError('Invalid agents.config.json', parsed.error));
};

export const parseClaimsFile = (input: unknown): Result<ClaimsFile, ContractError> => {
  const parsed = claimsFileSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err(toContractError('Invalid claims.json', parsed.error));
};

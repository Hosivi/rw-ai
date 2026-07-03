import { describe, expect, it } from 'vitest';
import { parseAgentsConfig } from '../contract/schema.js';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import type { DbDetection } from './database.js';
import { scaffoldConfig } from './scaffold.js';

const dockerDb: DbDetection = {
  strategy: 'docker',
  service: 'db',
  host: 'localhost',
  port: 5433,
  user: 'app',
  sources: ['docker-compose.yml'],
};

const noneDb: DbDetection = { strategy: 'none', host: 'localhost', port: 5432, sources: [] };

describe('scaffoldConfig', () => {
  it('maps a docker db detection to sessions with ports and db names', () => {
    const config = unwrap(
      scaffoldConfig({ projectName: 'shop', stacks: ['node'], sessionCount: 2, db: dockerDb }),
    );
    expect(config.db).toEqual({ strategy: 'docker', service: 'db', host: 'localhost', port: 5433, user: 'app' });
    expect(config.sessions).toHaveLength(2);
    for (const session of config.sessions) {
      expect(session.ports?.api).toBeGreaterThan(0);
      expect(session.db?.name).toMatch(/^shop_s\d+$/);
    }
  });

  it('falls back to the node stack when none was detected', () => {
    const config = unwrap(scaffoldConfig({ projectName: 'empty', stacks: [], sessionCount: 1 }));
    expect(config.project.stacks).toEqual(['node']);
    // node fallback still gets ports even without an explicit stack.
    expect(config.sessions[0]?.ports?.api).toBeGreaterThan(0);
  });

  it('produces a dotnet-only config with no ports and no db when the strategy is none', () => {
    const config = unwrap(
      scaffoldConfig({ projectName: 'svc', stacks: ['dotnet'], sessionCount: 2, db: noneDb }),
    );
    expect(config.project.stacks).toEqual(['dotnet']);
    expect(config.db.strategy).toBe('none');
    for (const session of config.sessions) {
      expect(session.ports).toBeUndefined();
      expect(session.db).toBeUndefined();
    }
  });

  it('drops undefined optional db fields when mapping to DbConfigInput', () => {
    const localDb: DbDetection = { strategy: 'local', host: 'localhost', port: 5432, sources: [] };
    const config = unwrap(
      scaffoldConfig({ projectName: 'app', stacks: ['node'], sessionCount: 1, db: localDb }),
    );
    expect(config.db).not.toHaveProperty('service');
    expect(config.db).not.toHaveProperty('user');
  });

  it('returns a config that passes parseAgentsConfig', () => {
    const config = unwrap(
      scaffoldConfig({ projectName: 'valid', stacks: ['node'], sessionCount: 3, db: dockerDb }),
    );
    expect(parseAgentsConfig(config).ok).toBe(true);
  });

  it('wraps a createDefaultConfig failure as a scaffold-invalid error', () => {
    const error = unwrapErr(scaffoldConfig({ projectName: 'x', stacks: ['node'], sessionCount: 0 }));
    expect(error.kind).toBe('invalid');
    expect(error.message.length).toBeGreaterThan(0);
  });
});

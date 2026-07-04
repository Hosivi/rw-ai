#!/usr/bin/env node
import os from 'node:os';
import { runCli } from './cli/run.js';
import { startRwMcpServer } from './mcp/server.js';

// The ONLY place that touches the real process/os: build the deps from process.*
// and hand the resolved exit code to process.exitCode. Every decision lives in
// the testable runCli/handlers, so this stays a thin wrapper.
const main = async (): Promise<void> => {
  // `rw mcp` starts a long-lived stdio MCP server, which does NOT fit the
  // runCli/CommandResult exit-code flow (it never returns while stdio is open),
  // so it is intercepted before routing.
  if (process.argv[2] === 'mcp') {
    await startRwMcpServer();
    return;
  }
  const code = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    homeDir: os.homedir(),
    env: process.env,
    now: new Date(),
    write: (s) => console.log(s),
  });
  process.exitCode = code;
};

void main();

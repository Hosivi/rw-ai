#!/usr/bin/env node
import os from 'node:os';
import { runCli } from './cli/run.js';
import { startRwMcpServer } from './mcp/server.js';

// Slurp STDIN to a string. Only `rw lane-guard` needs it (Claude Code delivers the
// PreToolUse payload on stdin). A TTY means no piped payload — return '' so a human
// who runs the hook by hand fails open (empty payload → allow) instead of hanging.
const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY === true) {
    return '';
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
};

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
  // Only the hook consumes stdin; every other command leaves it untouched so the
  // change stays isolated to `rw lane-guard`.
  const stdin = process.argv[2] === 'lane-guard' ? await readStdin() : undefined;
  const code = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    homeDir: os.homedir(),
    env: process.env,
    now: new Date(),
    write: (s) => console.log(s),
    writeErr: (s) => console.error(s),
    ...(stdin !== undefined ? { stdin } : {}),
  });
  process.exitCode = code;
};

void main();

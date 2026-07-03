#!/usr/bin/env node
import os from 'node:os';
import { runCli } from './cli/run.js';

// The ONLY place that touches the real process/os: build the deps from process.*
// and hand the resolved exit code to process.exitCode. Every decision lives in
// the testable runCli/handlers, so this stays a thin wrapper.
void runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  homeDir: os.homedir(),
  env: process.env,
  now: new Date(),
  write: (s) => console.log(s),
}).then((code) => {
  process.exitCode = code;
});

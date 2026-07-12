#!/usr/bin/env node

import { runCli } from './cli-command.js';

runCli(process.argv.slice(2))
  .then(code => {
    process.exitCode = code;
  })
  .catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });

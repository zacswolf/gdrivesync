#!/usr/bin/env node

import { runCli } from "./cliCore";
import { createDefaultCliRuntime, createNodeCliIo } from "./cliNodeRuntime";

const io = createNodeCliIo();
const runtime = createDefaultCliRuntime();

void runCli(process.argv.slice(2), runtime, io)
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });

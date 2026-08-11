#!/usr/bin/env node
import('../dist/src/relay/relayCli.js').then(({ runHadamardRelayCli }) => runHadamardRelayCli()).catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import('../dist/src/acp/acpCli.js').catch(error => {
  console.error('Failed to start hadamard-acp:', error);
  process.exit(1);
});

#!/usr/bin/env node
// Hadamard Canvas CLI entry (built output).
import('../dist/src/hcanvas/cli.js').catch(error => {
  console.error('hcanvas: ' + (error && error.message ? error.message : String(error)));
  console.error('Build first: npm run build');
  process.exit(1);
});

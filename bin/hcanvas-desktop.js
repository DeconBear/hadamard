#!/usr/bin/env node
// Standalone Electron launcher for Hadamard Canvas.
process.argv.splice(2, 0, 'desktop');
await import('./hcanvas.js');

#!/usr/bin/env node
// Standalone canvas surface: same backend/data as the main GUI, but the app shell
// only composes the canvas module.
process.env.HADAMARD_GUI_SURFACE = 'canvas';
await import('./hadamard-gui.js');

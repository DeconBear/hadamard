#!/usr/bin/env node
// Standalone harness surface: same backend/data as the main GUI, but the app
// shell only composes the agent harness (chat) module.
process.env.HADAMARD_GUI_SURFACE = 'harness';
await import('./hadamard-gui.js');

#!/usr/bin/env node
// Validate an Hcanvas v2 extension manifest with the same schema as the runtime.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const manifestPath = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('Usage: npm run hcanvas:extension:validate -- <path/to/manifest.json>');
  process.exit(2);
}

const modulePath = path.resolve(process.cwd(), 'dist', 'src', 'hcanvas', 'extensions', 'manifest.js');
let checkExtensionManifest;
try {
  ({ checkExtensionManifest } = await import(pathToFileURL(modulePath).href));
} catch {
  console.error('Hcanvas build output not found at dist/src/hcanvas/extensions/manifest.js');
  console.error('Run "npm run build" first, then retry.');
  process.exit(2);
}

let raw;
try {
  raw = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
  console.error('Cannot read manifest: ' + (error instanceof Error ? error.message : String(error)));
  process.exit(2);
}

const result = checkExtensionManifest(raw);
for (const warning of result.warnings || []) {
  console.warn((warning.path ? warning.path + ': ' : '') + warning.message + ' (warning)');
}
if (!result.ok) {
  for (const issue of result.errors || []) {
    console.error((issue.path ? issue.path + ': ' : '') + issue.message);
  }
  console.error('Invalid Hcanvas extension manifest: ' + manifestPath);
  process.exit(1);
}
console.log('OK ' + result.manifest.id + ' ' + result.manifest.version + ' — ' + manifestPath);

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATIC_IMPORT_PATTERN = /^(?:import|export)\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/gmu;
const DYNAMIC_IMPORT_PATTERN = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/gu;

async function sourceFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      const fullPath = path.join(directory, name);
      const info = await stat(fullPath);
      if (info.isDirectory()) await walk(fullPath);
      else if (/\.tsx?$/u.test(name) && !/\.d\.ts$/u.test(name)) files.push(path.normalize(fullPath));
    }
  }
  await walk(root);
  return files;
}

function resolveImport(from, specifier, nodes) {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(from), specifier.replace(/\.js$/u, ''));
  return [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]
    .map(candidate => path.normalize(candidate))
    .find(candidate => nodes.has(candidate));
}

export async function findSourceCycles(sourceRoot) {
  const root = path.resolve(sourceRoot);
  const files = await sourceFiles(root);
  const nodes = new Set(files);
  const graph = new Map();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const matches = [
      ...source.matchAll(STATIC_IMPORT_PATTERN),
      ...source.matchAll(DYNAMIC_IMPORT_PATTERN),
    ];
    const edges = new Set();
    for (const match of matches) {
      const target = resolveImport(file, match[1], nodes);
      if (target) edges.add(target);
    }
    graph.set(file, [...edges]);
  }

  let index = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const active = new Set();
  const cycles = [];
  function visit(node) {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    active.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(next)));
      } else if (active.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(next)));
      }
    }
    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const current = stack.pop();
      active.delete(current);
      component.push(current);
      if (current === node) break;
    }
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) cycles.push(component);
  }
  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  return cycles
    .map(component => component.map(file => path.relative(root, file).replaceAll('\\', '/')).sort())
    .sort((left, right) => right.length - left.length || left[0].localeCompare(right[0]));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const sourceRoot = path.resolve(process.argv[2] ?? 'src');
  const cycles = await findSourceCycles(sourceRoot);
  if (cycles.length > 0) {
    console.error(JSON.stringify({ sourceRoot, cycles }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ sourceRoot, cycles: [], passed: true }));
  }
}

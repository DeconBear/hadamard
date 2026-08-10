import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const DEFAULT_MAX_LINES = 1_000;
const DEFAULT_MAX_INTERFACE_MEMBERS = 20;

async function sourceFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && /\.tsx?$/u.test(entry.name) && !/\.d\.ts$/u.test(entry.name)) {
        files.push(absolute);
      }
    }
  }
  await walk(root);
  return files.sort();
}

function lineCount(source) {
  return source.length === 0 ? 0 : source.split(/\r?\n/u).length;
}

function normalizeRelative(root, file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

export async function inspectSolidBoundaries(sourceRoot, baseline = {}) {
  const root = path.resolve(sourceRoot);
  const fileBaselines = baseline.files ?? {};
  const interfaceBaselines = baseline.interfaces ?? {};
  const violations = [];
  const observed = { files: {}, interfaces: {} };

  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, 'utf8');
    const relative = normalizeRelative(root, file);
    const lines = lineCount(source);
    if (lines > DEFAULT_MAX_LINES) observed.files[relative] = lines;
    const fileLimit = fileBaselines[relative]?.maxLines ?? DEFAULT_MAX_LINES;
    if (lines > fileLimit) {
      violations.push({
        kind: 'file-size',
        target: relative,
        actual: lines,
        limit: fileLimit,
      });
    }

    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = node => {
      if (ts.isInterfaceDeclaration(node)) {
        const key = `${relative}#${node.name.text}`;
        const members = node.members.length;
        if (members > DEFAULT_MAX_INTERFACE_MEMBERS) observed.interfaces[key] = members;
        const interfaceLimit = interfaceBaselines[key]?.maxMembers ?? DEFAULT_MAX_INTERFACE_MEMBERS;
        if (members > interfaceLimit) {
          violations.push({
            kind: 'interface-size',
            target: key,
            actual: members,
            limit: interfaceLimit,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return {
    passed: violations.length === 0,
    thresholds: {
      defaultMaxLines: DEFAULT_MAX_LINES,
      defaultMaxInterfaceMembers: DEFAULT_MAX_INTERFACE_MEMBERS,
    },
    violations,
    observed,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const sourceRoot = path.resolve(process.argv[2] ?? 'src');
  const baselineFlag = process.argv.indexOf('--baseline');
  const baselinePath = path.resolve(
    baselineFlag >= 0 && process.argv[baselineFlag + 1]
      ? process.argv[baselineFlag + 1]
      : 'etc/solid-boundaries.json',
  );
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const result = await inspectSolidBoundaries(sourceRoot, baseline);
  const serialized = JSON.stringify({
    sourceRoot,
    baselinePath,
    passed: result.passed,
    thresholds: result.thresholds,
    violations: result.violations,
  }, null, 2);
  if (result.passed) console.log(serialized);
  else {
    console.error(serialized);
    process.exitCode = 1;
  }
}

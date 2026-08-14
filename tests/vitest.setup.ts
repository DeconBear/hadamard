import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolated = mkdtempSync(path.join(os.tmpdir(), 'hadamard-vitest-'));
const home = path.join(isolated, 'home');
const work = path.join(isolated, 'work');
mkdirSync(home, { recursive: true });
mkdirSync(work, { recursive: true });

process.env.HADAMARD_HOME = home;
process.env.HADAMARD_WORKDIR = work;

import { spawn } from 'node:child_process';
import path from 'node:path';

import { PYTHON_KERNEL_PROGRAM } from './pythonKernelProgram.js';
import { startKernelProcess, type KernelProcessInvocation } from './processKernelAdapter.js';
import type {
  CodeActBackendStatus,
  CodeActKernel,
  CodeActKernelAdapter,
  CodeActKernelStartOptions,
} from './types.js';

export interface ContainerKernelAdapterOptions {
  runtime?: 'docker' | 'podman';
  image: string;
  memoryMb: number;
  cpuLimit: number;
}

export class ContainerKernelAdapter implements CodeActKernelAdapter {
  readonly backend = 'container' as const;
  readonly isolation = 'strong' as const;
  private readonly runtime: 'docker' | 'podman';

  constructor(private readonly options: ContainerKernelAdapterOptions) {
    this.runtime = options.runtime ?? 'docker';
  }

  async selfCheck(): Promise<CodeActBackendStatus> {
    const detail = await inspectImage(this.runtime, this.options.image);
    return {
      backend: this.backend,
      available: detail.available,
      isolation: this.isolation,
      detail: detail.available
        ? `${this.runtime} image ${this.options.image} is available with network disabled.`
        : `${this.runtime} container backend unavailable: ${detail.detail}`,
    };
  }

  async start(options: CodeActKernelStartOptions): Promise<CodeActKernel> {
    return startKernelProcess(
      options,
      buildContainerKernelInvocation(this.runtime, this.options, options),
    );
  }
}

export function buildContainerKernelInvocation(
  runtime: 'docker' | 'podman',
  adapter: ContainerKernelAdapterOptions,
  options: CodeActKernelStartOptions,
): KernelProcessInvocation {
  const workspace = path.resolve(options.workDir);
  const environmentArgs = Object.entries(options.environment)
    .filter(([key]) => key.startsWith('HADAMARD_') || key.startsWith('PYTHON'))
    .flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  return {
    command: runtime,
    args: [
      'run', '--interactive', '--rm', '--network', 'none',
      '--pids-limit', '128', '--memory', `${adapter.memoryMb}m`,
      '--cpus', String(adapter.cpuLimit),
      '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--volume', `${workspace}:/workspace:rw`, '--workdir', '/workspace',
      ...environmentArgs,
      adapter.image, 'python', '-u', '-c', PYTHON_KERNEL_PROGRAM,
    ],
    cwd: workspace,
    env: Object.fromEntries(
      Object.entries(options.environment)
        .filter(([key]) => !/(api[_-]?key|token|secret|password|credential|auth)/i.test(key)),
    ),
  };
}

async function inspectImage(
  runtime: 'docker' | 'podman',
  image: string,
): Promise<{ available: boolean; detail: string }> {
  return new Promise(resolve => {
    const child = spawn(runtime, ['image', 'inspect', image], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ available: false, detail: 'self-check timed out' });
    }, 10_000);
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => {
      clearTimeout(timer);
      resolve({ available: false, detail: error.message });
    });
    child.once('exit', code => {
      clearTimeout(timer);
      resolve({ available: code === 0, detail: stderr.trim() || `exit code ${code}` });
    });
  });
}

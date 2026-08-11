import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  AppServer,
  APP_SERVER_LEGACY_PROTOCOL_VERSION,
  APP_SERVER_PROTOCOL_VERSION,
  parseAppServerRequest,
  StdioAppServerTransport,
} from '../src/app-server/index.js';
import type { HadamardAgentClient } from '../src/runtime/agentClient.js';

describe('app-server protocol', () => {
  it('accepts versioned requests and rejects malformed input', () => {
    expect(parseAppServerRequest({
      version: APP_SERVER_PROTOCOL_VERSION,
      id: 'request-1',
      method: 'initialize',
      params: {},
    })).toMatchObject({ id: 'request-1', method: 'initialize' });

    expect(parseAppServerRequest({
      version: APP_SERVER_LEGACY_PROTOCOL_VERSION,
      id: 'request-2',
      method: 'initialize',
    })).toMatchObject({ version: 1, id: 'request-2' });
    expect(() => parseAppServerRequest({
      version: 3,
      id: 'request-unsupported',
      method: 'initialize',
    })).toThrow('Invalid app-server request');
    expect(() => parseAppServerRequest({
      version: 1,
      id: 'request-3',
      method: 'initialize',
      params: [],
    })).toThrow('Invalid app-server request');
  });

  it('keeps legacy v1 stdio initialize clients compatible', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', chunk => { text += chunk.toString(); });
    const run = new StdioAppServerTransport(
      new AppServer({} as HadamardAgentClient),
      input,
      output,
    ).start();
    input.end(`${JSON.stringify({ version: 1, id: 'legacy-init', method: 'initialize' })}\n`);
    await run;
    expect(JSON.parse(text.trim())).toEqual({
      version: 1,
      id: 'legacy-init',
      result: {
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
        capabilities: [
          'sessions',
          'streaming',
          'session-tree',
          'diff',
          'checkpoints',
          'goals',
          'approvals',
        ],
      },
    });
  });
});

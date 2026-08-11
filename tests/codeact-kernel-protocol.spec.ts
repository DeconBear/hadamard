import { describe, expect, it } from 'vitest';

import {
  KernelLineDecoder,
  KernelProtocolError,
  parseKernelInboundMessage,
} from '../src/codeact/index.js';

describe('CodeAct kernel protocol', () => {
  it('decodes fragmented JSON lines without confusing user stdout for framing', () => {
    const decoder = new KernelLineDecoder();
    expect(decoder.push('{"v":1,"type":"stream","executionId":"e1",')).toEqual([]);
    expect(decoder.push('"stream":"stdout","delta":"{\\"type\\":\\"fake\\"}\\n"}\n')).toEqual([{
      v: 1,
      type: 'stream',
      executionId: 'e1',
      stream: 'stdout',
      delta: '{"type":"fake"}\n',
    }]);
  });

  it('rejects malformed, oversized, and fuzzed protocol messages', () => {
    expect(() => parseKernelInboundMessage('not-json')).toThrow(KernelProtocolError);
    expect(() => parseKernelInboundMessage('{"v":2,"type":"ready","pid":1}')).toThrow(
      /invalid version/i,
    );
    expect(() => new KernelLineDecoder(8).push('123456789')).toThrow(/exceeded/);
    for (let index = 0; index < 100; index += 1) {
      const fuzz = JSON.stringify({
        v: index % 3,
        type: `unknown-${index}`,
        executionId: index,
        payload: '\u0000'.repeat(index % 5),
      });
      expect(() => parseKernelInboundMessage(fuzz)).toThrow(KernelProtocolError);
    }
  });
});

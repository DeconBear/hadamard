import type { IncomingMessage } from 'node:http';
import { expect, it } from 'vitest';
import { createGuiLoopbackGuards } from '../src/gui/guiLoopbackGuards.js';

it('preserves the existing loopback Host and Origin policy', () => {
  const guard = createGuiLoopbackGuards('127.0.0.1');
  const req = (headers: Record<string, string>) => ({ headers }) as IncomingMessage;
  expect(guard.hostHeaderAllowed(req({ host: 'localhost:4175' }))).toBe(true);
  expect(guard.hostHeaderAllowed(req({ host: '[::1]:4175' }))).toBe(true);
  expect(guard.hostHeaderAllowed(req({ host: 'evil.example' }))).toBe(false);
  expect(guard.hostHeaderAllowed(req({}))).toBe(false);
  expect(guard.originAllowed(req({}))).toBe(true);
  expect(guard.originAllowed(req({ origin: 'http://127.0.0.1:4175' }))).toBe(true);
  expect(guard.originAllowed(req({ origin: 'https://evil.example' }))).toBe(false);
  expect(guard.originAllowed(req({ origin: 'null' }))).toBe(false);
});

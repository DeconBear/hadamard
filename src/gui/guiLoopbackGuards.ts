import type { IncomingMessage } from 'node:http';

/** Existing GUI Host/Origin guards, shared without weakening loopback policy. */
export function createGuiLoopbackGuards(host: string) {
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', host.toLowerCase()]);
  const hostHeaderAllowed = (req: IncomingMessage): boolean => {
    const header = req.headers.host;
    if (!header) return false;
    return loopbackHosts.has(header.replace(/:\d+$/, '').toLowerCase());
  };
  const originAllowed = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients and same-origin GETs omit Origin
    try {
      return loopbackHosts.has(new URL(origin).hostname.toLowerCase());
    } catch {
      return false;
    }
  };

  return { hostHeaderAllowed, originAllowed };
}

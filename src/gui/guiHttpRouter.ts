import type { IncomingMessage, ServerResponse } from 'node:http';

export type GuiHttpMethod = 'DELETE' | 'GET' | 'POST' | 'PUT';
export type GuiHttpMatcher = string | RegExp | ((url: URL) => boolean);
export type GuiHttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) => void | Promise<void>;

interface GuiHttpRoute {
  method: GuiHttpMethod;
  matcher: GuiHttpMatcher;
  handler: GuiHttpHandler;
}

function matches(matcher: GuiHttpMatcher, url: URL): boolean {
  if (typeof matcher === 'string') return url.pathname === matcher;
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(url.pathname);
  }
  return matcher(url);
}

export class GuiHttpRouter {
  private readonly routes: GuiHttpRoute[] = [];

  route(method: GuiHttpMethod, matcher: GuiHttpMatcher, handler: GuiHttpHandler): this {
    this.routes.push({ method, matcher, handler });
    return this;
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = req.method?.toUpperCase();
    const route = this.routes.find(candidate =>
      candidate.method === method && matches(candidate.matcher, url),
    );
    if (!route) return false;
    await route.handler(req, res, url);
    return true;
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

export function text(res: ServerResponse, status: number, body: string, type = 'text/plain'): void {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function bytes(res: ServerResponse, status: number, body: Buffer, type: string): void {
  res.writeHead(status, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'public, max-age=86400',
  });
  res.end(body);
}

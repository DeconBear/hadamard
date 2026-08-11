export const APP_SERVER_LEGACY_PROTOCOL_VERSION = 1 as const;
export const APP_SERVER_PROTOCOL_VERSION = 2 as const;
export const APP_SERVER_PROTOCOL_VERSIONS = [
  APP_SERVER_LEGACY_PROTOCOL_VERSION,
  APP_SERVER_PROTOCOL_VERSION,
] as const;

export type AppServerProtocolVersion = typeof APP_SERVER_PROTOCOL_VERSIONS[number];

interface AppServerRequestBase {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface AppServerRequestV1 extends AppServerRequestBase {
  version: 1;
}

export interface AppServerRequestV2 extends AppServerRequestBase {
  version: 2;
  /** Transport-specific authentication metadata. App Server does not interpret it. */
  auth?: Record<string, unknown>;
}

export type AppServerRequest = AppServerRequestV1 | AppServerRequestV2;

export interface AppServerResponse {
  version: AppServerProtocolVersion;
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface AppServerNotification {
  version: AppServerProtocolVersion;
  type: 'event';
  method: string;
  params: Record<string, unknown>;
}

export function parseAppServerRequest(value: unknown): AppServerRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid app-server request.');
  const request = value as Partial<AppServerRequest>;
  if (
    (request.version !== APP_SERVER_LEGACY_PROTOCOL_VERSION
      && request.version !== APP_SERVER_PROTOCOL_VERSION)
    || typeof request.id !== 'string'
    || !request.id.trim()
    || typeof request.method !== 'string'
    || !request.method.trim()
    || (request.params !== undefined
      && (typeof request.params !== 'object' || request.params === null || Array.isArray(request.params)))
    || ('auth' in request
      && request.auth !== undefined
      && (request.version !== APP_SERVER_PROTOCOL_VERSION
        || typeof request.auth !== 'object'
        || request.auth === null
        || Array.isArray(request.auth)))
  ) throw new Error('Invalid app-server request.');
  return request as AppServerRequest;
}

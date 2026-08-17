import QRCode from 'qrcode';

import type { PersistedBridgeConfig } from '../parity/bridgeConfigs.js';

/**
 * Static provider export for the mobile companion app. The desktop GUI encodes
 * a saved bridge config (name, base URL, model and API key) directly into a QR
 * code; the phone scans it and imports the provider without any network
 * handshake. Anyone who scans the code gets the full API key, so the payload
 * is never transmitted anywhere — it only exists as the rendered QR image.
 */
export const PROVIDER_SHARE_QR_TYPE = 'hadamard-provider';

export interface ProviderSharePayload {
  type: typeof PROVIDER_SHARE_QR_TYPE;
  version: 1;
  displayName: string;
  endpoint: string;
  model: string;
  apiKey: string;
}

export function buildProviderSharePayload(config: PersistedBridgeConfig): ProviderSharePayload {
  const endpoint = (config.baseURL ?? '').trim();
  const model = (config.models?.[0]?.name ?? config.model ?? '').trim();
  const apiKey = (config.apiKey ?? '').trim();
  if (!/^https:\/\//i.test(endpoint)) {
    throw new Error(`Config "${config.name}" needs an HTTPS base URL before it can be shared with the phone.`);
  }
  if (!model) {
    throw new Error(`Config "${config.name}" has no model to share. Add a model first.`);
  }
  if (!apiKey) {
    throw new Error(`Config "${config.name}" has no API key to share.`);
  }
  return {
    type: PROVIDER_SHARE_QR_TYPE,
    version: 1,
    displayName: config.name,
    endpoint,
    model,
    apiKey,
  };
}

export async function renderProviderShareQrDataUrl(payload: ProviderSharePayload): Promise<string> {
  return QRCode.toDataURL(JSON.stringify(payload), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 320,
  });
}

const HADAMARD_AUTH_ENV_KEYS = new Set([
  'HADAMARD_API_KEY',
  'HADAMARD_AUTH_TOKEN',
  'HADAMARD_BASE_URL',
]);
const SENSITIVE_ENV_KEY = /(?:^|_)(?:API_?KEY|AUTH|COOKIE|CREDENTIALS?|KEY|PASS(?:WORD|WD)?|PRIVATE_KEY|SECRET|TOKEN)(?:$|_)/iu;

export function nativeChildEnvironment(
  overrides: Record<string, string> | undefined,
): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  return Object.fromEntries(Object.entries({ ...base, ...overrides })
    .filter(([key]) => !HADAMARD_AUTH_ENV_KEYS.has(key)));
}

export function nativeSensitiveValues(environment: Record<string, string>): string[] {
  return Object.entries(environment)
    .filter(([key, value]) => value.length > 0 && SENSITIVE_ENV_KEY.test(key))
    .map(([, value]) => value);
}

export interface DesignThemeTokens {
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  mutedColor: string;
  fontFamily: string;
  codeFontFamily: string;
  pageWidth: number;
  cover: boolean;
  logoDataUrl?: string;
  header?: string;
  footer?: string;
  codeTheme: 'light' | 'dark';
}

export interface DesignTheme {
  id: string;
  name: string;
  tokens: Readonly<DesignThemeTokens>;
}

const SAFE_COLOR = /^(?:#[0-9a-f]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/iu;
const SAFE_FONT = /^[\w\s,.'"-]{1,160}$/u;
const SAFE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/u;

export const DEFAULT_DESIGN_THEMES: readonly DesignTheme[] = Object.freeze([
  {
    id: 'clean-light',
    name: 'Clean light',
    tokens: {
      accentColor: '#2563eb', backgroundColor: '#ffffff', textColor: '#172033', mutedColor: '#64748b',
      fontFamily: "Inter, 'Segoe UI', sans-serif", codeFontFamily: "'SFMono-Regular', Consolas, monospace",
      pageWidth: 920, cover: true, codeTheme: 'light',
    },
  },
  {
    id: 'clean-dark',
    name: 'Clean dark',
    tokens: {
      accentColor: '#7dd3fc', backgroundColor: '#111827', textColor: '#f8fafc', mutedColor: '#94a3b8',
      fontFamily: "Inter, 'Segoe UI', sans-serif", codeFontFamily: "'SFMono-Regular', Consolas, monospace",
      pageWidth: 920, cover: true, codeTheme: 'dark',
    },
  },
]);

export function validateDesignThemeTokens(
  input: Partial<DesignThemeTokens>,
  base: DesignThemeTokens = DEFAULT_DESIGN_THEMES[0]!.tokens,
): DesignThemeTokens {
  const color = (value: unknown, fallback: string): string =>
    typeof value === 'string' && SAFE_COLOR.test(value) ? value : fallback;
  const font = (value: unknown, fallback: string): string =>
    typeof value === 'string' && SAFE_FONT.test(value) ? value : fallback;
  const shortText = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length <= 200 ? value : undefined;
  const logoDataUrl = typeof input.logoDataUrl === 'string' && input.logoDataUrl.length <= 512_000
    && SAFE_DATA_URL.test(input.logoDataUrl) ? input.logoDataUrl : undefined;
  return {
    accentColor: color(input.accentColor, base.accentColor),
    backgroundColor: color(input.backgroundColor, base.backgroundColor),
    textColor: color(input.textColor, base.textColor),
    mutedColor: color(input.mutedColor, base.mutedColor),
    fontFamily: font(input.fontFamily, base.fontFamily),
    codeFontFamily: font(input.codeFontFamily, base.codeFontFamily),
    pageWidth: typeof input.pageWidth === 'number' && Number.isInteger(input.pageWidth)
      ? Math.max(560, Math.min(1440, input.pageWidth)) : base.pageWidth,
    cover: typeof input.cover === 'boolean' ? input.cover : base.cover,
    ...(logoDataUrl ? { logoDataUrl } : {}),
    ...(shortText(input.header) ? { header: shortText(input.header) } : {}),
    ...(shortText(input.footer) ? { footer: shortText(input.footer) } : {}),
    codeTheme: input.codeTheme === 'dark' || input.codeTheme === 'light' ? input.codeTheme : base.codeTheme,
  };
}

export function resolveDesignTheme(id: string, overrides: Partial<DesignThemeTokens> = {}): DesignTheme {
  const theme = DEFAULT_DESIGN_THEMES.find(candidate => candidate.id === id) ?? DEFAULT_DESIGN_THEMES[0]!;
  return { ...theme, tokens: validateDesignThemeTokens(overrides, theme.tokens) };
}

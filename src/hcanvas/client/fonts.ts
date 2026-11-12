export interface FontOption {
  id: string;
  label: string;
  family: string;
  description: string;
}

/** Bundled families first; the remaining choices use fonts that ship with common desktop OSes. */
export const FONT_OPTIONS: FontOption[] = [
  {
    id: 'inter',
    label: 'Inter',
    family: "Inter, 'Segoe UI', 'Microsoft YaHei', 'PingFang SC', sans-serif",
    description: 'Bundled · clean sans',
  },
  {
    id: 'source-serif',
    label: 'Source Serif 4',
    family: "'Source Serif 4', Georgia, 'Songti SC', 'SimSun', serif",
    description: 'Bundled · editorial serif',
  },
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    family: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
    description: 'Bundled · monospace',
  },
  {
    id: 'georgia',
    label: 'Georgia',
    family: "Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif",
    description: 'System serif',
  },
  {
    id: 'system',
    label: 'System UI',
    family: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif",
    description: 'System interface font',
  },
  {
    id: 'yahei',
    label: '微软雅黑',
    family: "'Microsoft YaHei', 'PingFang SC', 'Noto Sans CJK SC', sans-serif",
    description: '中文无衬线（系统）',
  },
  {
    id: 'songti',
    label: '宋体',
    family: "'Songti SC', 'SimSun', 'Noto Serif CJK SC', serif",
    description: '中文衬线（系统）',
  },
];

function firstFamilyName(value: string | undefined): string {
  return String(value || '').split(',')[0]!.replace(/["']/g, '').trim().toLowerCase();
}

/** Find the picker option matching a stored CSS font-family stack. */
export function fontOptionFor(value: string | undefined): FontOption {
  const first = firstFamilyName(value);
  if (first) {
    const match = FONT_OPTIONS.find(option => firstFamilyName(option.family) === first);
    if (match) return match;
  }
  return FONT_OPTIONS[0]!;
}

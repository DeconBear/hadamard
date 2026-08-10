export interface SolidBoundaryBaseline {
  files?: Record<string, { maxLines: number; reason?: string }>;
  interfaces?: Record<string, { maxMembers: number; reason?: string }>;
}

export interface SolidBoundaryViolation {
  kind: 'file-size' | 'interface-size';
  target: string;
  actual: number;
  limit: number;
}

export interface SolidBoundaryInspection {
  passed: boolean;
  thresholds: {
    defaultMaxLines: number;
    defaultMaxInterfaceMembers: number;
  };
  violations: SolidBoundaryViolation[];
  observed: {
    files: Record<string, number>;
    interfaces: Record<string, number>;
  };
}

export function inspectSolidBoundaries(
  sourceRoot: string,
  baseline?: SolidBoundaryBaseline,
): Promise<SolidBoundaryInspection>;

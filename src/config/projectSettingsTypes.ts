import type { HadamardRunEffort } from '../contracts/runtimeOptions.js';

export type ProjectInstructionMode = 'agents' | 'claude' | 'both';

export type DreamExecutionProfileRef =
  | { kind: 'config'; name: string; model?: string; effort?: HadamardRunEffort }
  | { kind: 'agent'; name: string; effort?: HadamardRunEffort };

export interface ProjectMemorySettings {
  compact: {
    enabled: boolean;
    autoCompactTokenLimit?: number;
    autoCompactTokenLimitScope: 'total' | 'body_after_prefix';
  };
  durableMemory: {
    use: boolean;
    autoDream: boolean;
    dreamExecutionProfile?: DreamExecutionProfileRef;
    /** Local HH:mm for GUI-scheduled daily dream (default 03:00). */
    dailyDreamTimeLocal: string;
    /** YYYY-MM-DD of last GUI-triggered scheduled dream run. */
    lastScheduledDreamDate?: string;
    minRolloutIdleHours: number;
    maxRolloutAgeDays: number;
    maxRolloutsPerStartup: number;
  };
}

export type ProjectMemorySettingsPatch = {
  compact?: Partial<ProjectMemorySettings['compact']>;
  durableMemory?: Omit<Partial<ProjectMemorySettings['durableMemory']>, 'dreamExecutionProfile'> & {
    dreamExecutionProfile?: DreamExecutionProfileRef | null;
  };
};

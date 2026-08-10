import type { HadamardPermissionMode } from '../types.js';
import type { InputEditor } from './editor.js';
import type { TuiSelectionItem } from './selection.js';

export interface HadamardTuiOptions {
  workDir?: string;
  configPath?: string;
  permissionMode?: HadamardPermissionMode;
  model?: string;
  resumeSessionId?: string;
  continueMostRecent?: boolean;
}

export interface PermissionDialogState {
  toolName: string;
  summary: string;
  selected: number;
  resolve: (outcome: 'allow' | 'always' | 'always-user' | 'deny') => void;
}

export interface SelectionDialogState {
  title: string;
  subtitle?: string;
  items: TuiSelectionItem[];
  selected: number;
  query: string;
  searchable: boolean;
  resolve: (itemId: string | undefined) => void;
}

export interface TextInputDialogState {
  title: string;
  label: string;
  description?: string;
  editor: InputEditor;
  secret: boolean;
  resolve: (value: string | undefined) => void;
}

export interface TuiKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

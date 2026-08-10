export interface HadamardMemoryCommandResult {
  title: string;
  message: string;
  text?: string;
  items?: Array<{ label: string; description?: string; detail?: string }>;
}

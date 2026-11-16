export type HcCommandHandler = () => void | Promise<void>;

export interface HcCommand {
  id: string;
  title: string;
  category?: string;
  /** Reserved for P2 when-clause filtering. */
  when?: string;
  handler: HcCommandHandler;
}

export interface HcCommandInfo {
  id: string;
  title: string;
  category?: string;
  when?: string;
}

class CommandRegistry {
  private commands = new Map<string, HcCommand>();

  register(command: HcCommand, allowOverride = false): boolean {
    if (!command.id || !command.title) throw new Error('Command requires id and title');
    if (!allowOverride && this.commands.has(command.id)) return false;
    this.commands.set(command.id, command);
    return true;
  }

  unregister(id: string): boolean {
    return this.commands.delete(id);
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  get(id: string): HcCommand | null {
    return this.commands.get(id) || null;
  }

  list(): HcCommandInfo[] {
    return [...this.commands.values()].map(command => ({ id: command.id, title: command.title, category: command.category, when: command.when }));
  }

  async execute(id: string): Promise<boolean> {
    const command = this.commands.get(id);
    if (!command) return false;
    await command.handler();
    return true;
  }
}

export const commandRegistry = new CommandRegistry();

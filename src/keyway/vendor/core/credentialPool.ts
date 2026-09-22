import type { CredentialHealth, ManagedCredential } from './contracts.js';

/** Python v0.2 parity: round-robin inside the lowest healthy priority band. */
export class CredentialPool {
  private readonly cursors = new Map<string, number>();

  select(
    providerId: string,
    credentials: readonly ManagedCredential[],
    health: ReadonlyMap<string, CredentialHealth | undefined>,
    now = new Date(),
  ): ManagedCredential | undefined {
    const eligible = credentials.filter(credential => (
      credential.providerId === providerId
      && credential.enabled
      && !isCircuitOpen(health.get(credential.id), now)
    ));
    if (eligible.length === 0) return undefined;
    const minimumPriority = Math.min(...eligible.map(credential => credential.priority));
    const band = eligible
      .filter(credential => credential.priority === minimumPriority)
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id)
      ));
    const cursor = this.cursors.get(providerId) ?? 0;
    const selected = band[cursor % band.length];
    this.cursors.set(providerId, cursor + 1);
    return selected;
  }

  reset(providerId?: string): void {
    if (providerId === undefined) this.cursors.clear();
    else this.cursors.delete(providerId);
  }
}

function isCircuitOpen(health: CredentialHealth | undefined, now: Date): boolean {
  if (!health || health.state !== 'circuit-open') return false;
  if (!health.circuitOpenUntil) return true;
  const until = Date.parse(health.circuitOpenUntil);
  return !Number.isFinite(until) || now.getTime() < until;
}

export interface MemberIdentity {
  id: string;
  model: string;
  role?: string;
}

/** Assign stable, unique identities without depending on the team runtime. */
export function buildMemberIdentities(
  members: Array<{ id?: string; name?: string; role?: string; model?: string }>,
): MemberIdentity[] {
  const used = new Map<string, number>();
  return members.map((member) => {
    const base = (member.id ?? member.name ?? member.role ?? member.model ?? 'member').trim() || 'member';
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}#${seen + 1}`;
    return { id, model: member.model ?? '', role: member.role };
  });
}

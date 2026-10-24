import type { State, Principal } from './model.ts';
export function permission(
  s: State,
  actor: Principal,
): 'owner' | 'viewer' | 'operator' | 'service' | undefined {
  if (s.run.ownerIdentityHex === actor.identityHex) return 'owner';
  return s.members.find((m) => m.enabled && m.identityHex === actor.identityHex)
    ?.permission;
}
export function requireControl(s: State, actor: Principal): void {
  const p = permission(s, actor);
  if (p !== 'owner' && p !== 'operator') throw new Error('FORBIDDEN_CONTROL');
}
export function requireOwner(s: State, actor: Principal): void {
  if (permission(s, actor) !== 'owner') throw new Error('FORBIDDEN_OWNER');
}
export function requireService(s: State, actor: Principal): void {
  if (permission(s, actor) !== 'service') throw new Error('FORBIDDEN_SERVICE');
}

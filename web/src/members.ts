/**
 * The household on this Echo Show. `name` is what goes in X-Household-Member,
 * so it must match the names on items (the demo seed uses Priya and Dan).
 */
export interface Member {
  label: string;
  name: string;
  initial: string;
  /** Avatar gradient. */
  tint: string;
}

export const MEMBERS: Member[] = [
  { label: 'Mom', name: 'Priya', initial: 'M', tint: 'from-rose-400 to-orange-300' },
  { label: 'Dad', name: 'Dan', initial: 'D', tint: 'from-sky-400 to-indigo-500' },
  { label: 'Riya', name: 'Riya', initial: 'R', tint: 'from-emerald-300 to-teal-500' },
];

const KEY = 'fridge-door.member';

export function loadMemberIndex(): number {
  try {
    const i = Number(localStorage.getItem(KEY));
    return Number.isInteger(i) && i >= 0 && i < MEMBERS.length ? i : 0;
  } catch {
    return 0;
  }
}

export function saveMemberIndex(i: number): void {
  try {
    localStorage.setItem(KEY, String(i));
  } catch {
    // Private window or blocked storage: the choice just isn't remembered.
  }
}

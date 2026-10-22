import type { Obligation, ObligationType, Source } from '@fridge-door/shared';

const DAY_MS = 86_400_000;

function parts(when: string | number, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(when)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute) };
}

/** Whole days from today to the date, in the household time zone. */
function dayOffset(iso: string, tz: string, now: number): number {
  const a = parts(now, tz);
  const b = parts(iso, tz);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

/** Items "due on a day" are stored as 23:59:59.999 local; they have no real time. */
export function hasTime(iso: string, tz: string): boolean {
  const p = parts(iso, tz);
  return !(p.h === 23 && p.min === 59);
}

/** { day: "Tomorrow", time: "4:15 PM" } style labels. */
export function when(iso: string, tz: string, now = Date.now()): { day: string; time: string | null } {
  const offset = dayOffset(iso, tz, now);
  const date = new Date(iso);
  let day: string;
  if (offset === 0) day = 'Today';
  else if (offset === 1) day = 'Tomorrow';
  else if (offset === -1) day = 'Yesterday';
  else if (offset > 1 && offset < 7) day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(date);
  else day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(date);
  const time = hasTime(iso, tz) ? new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(date) : null;
  return { day, time };
}

export function whenText(iso: string, tz: string, now = Date.now()): string {
  const w = when(iso, tz, now);
  return w.time ? `${w.day} · ${w.time}` : w.day;
}

export function isOverdue(o: Obligation, now = Date.now()): boolean {
  return o.status === 'pending' && Date.parse(o.dueDate) < now;
}

/** "Thu, Nov 12" for a YYYY-MM-DD date. */
export function plainDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(Date.UTC(y!, m! - 1, d!));
}

export function money(amount: number | null, currency: string): string | null {
  if (amount === null) return null;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function ago(iso: string, now = Date.now()): string {
  const mins = Math.round((now - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export const SOURCE_NOUN: Record<Source, string> = {
  gmail: 'email',
  whatsapp: 'WhatsApp message',
  photo: 'photo',
  manual: 'request',
};

export const TYPE_LABEL: Record<ObligationType, string> = {
  bill: 'Bill',
  order: 'Delivery',
  booking: 'Booking',
  appointment: 'Appointment',
  deadline: 'Deadline',
  renewal: 'Renewal',
};

export function clock(tz: string, now: number): { time: string; period: string; date: string } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const date = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(now));
  return { time: `${p.hour}:${p.minute}`, period: p.dayPeriod ?? '', date };
}

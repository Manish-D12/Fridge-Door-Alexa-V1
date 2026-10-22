import type { ObligationType, Source } from '@fridge-door/shared';
import { AlarmClock, Camera, Mail, MessageCircle, Mic, Package, Receipt, RefreshCw, Stethoscope, Ticket, type LucideIcon } from 'lucide-react';

const TYPES: Record<ObligationType, { icon: LucideIcon; tint: string }> = {
  bill: { icon: Receipt, tint: 'from-amber-300/90 to-orange-500/90 text-amber-950' },
  order: { icon: Package, tint: 'from-sky-300/90 to-blue-500/90 text-sky-950' },
  booking: { icon: Ticket, tint: 'from-violet-300/90 to-fuchsia-500/90 text-violet-950' },
  appointment: { icon: Stethoscope, tint: 'from-rose-300/90 to-pink-500/90 text-rose-950' },
  deadline: { icon: AlarmClock, tint: 'from-orange-200/90 to-red-500/90 text-red-950' },
  renewal: { icon: RefreshCw, tint: 'from-emerald-200/90 to-teal-500/90 text-emerald-950' },
};

export function TypeIcon({ type, size = 44 }: { type: ObligationType; size?: number }) {
  const { icon: Icon, tint } = TYPES[type];
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br shadow-lg shadow-black/30 ${tint}`}
      style={{ width: size, height: size }}
    >
      <Icon size={size * 0.5} strokeWidth={2.2} />
    </span>
  );
}

export const SOURCE_ICON: Record<Source, LucideIcon> = {
  gmail: Mail,
  whatsapp: MessageCircle,
  photo: Camera,
  manual: Mic,
};

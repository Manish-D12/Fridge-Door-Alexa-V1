import { useEffect, useState } from 'react';
import type { Obligation } from '@fridge-door/shared';
import { CalendarDays, Lock, PartyPopper } from 'lucide-react';
import { clock, isOverdue, money, TYPE_LABEL, when } from '../format';
import { TypeIcon } from './TypeIcon';

const ROTATE_MS = 6000;

export function IdleScreen({ items, tz, now, loaded }: { items: Obligation[]; tz: string; now: number; loaded: boolean }) {
  const c = clock(tz, now);
  return (
    <div className="absolute inset-0 flex items-center justify-between px-[92px] pb-10">
      <div className="rise-in">
        <div className="flex items-start font-extralight leading-none tracking-[-0.04em] text-white" style={{ fontSize: 196 }}>
          {c.time}
          <span className="ml-4 mt-7 text-[40px] font-light tracking-normal text-white/60">{c.period}</span>
        </div>
        <div className="mt-6 pl-2 text-[34px] font-light text-white/75">{c.date}</div>
      </div>
      <ComingUp items={items} tz={tz} now={now} loaded={loaded} />
    </div>
  );
}

function ComingUp({ items, tz, now, loaded }: { items: Obligation[]; tz: string; now: number; loaded: boolean }) {
  const [index, setIndex] = useState(0);
  const count = items.length;

  useEffect(() => {
    setIndex(0);
    if (count < 2) return;
    const t = window.setInterval(() => setIndex((i) => (i + 1) % count), ROTATE_MS);
    return () => window.clearInterval(t);
  }, [count, items]);

  const item = items[index % Math.max(count, 1)];
  return (
    <div className="glass rise-in w-[440px] rounded-[32px] p-8" style={{ animationDelay: '120ms' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5 text-[17px] font-semibold uppercase tracking-[0.16em] text-alexa">
          <CalendarDays size={20} /> Coming up
        </div>
        {count > 1 && (
          <div className="flex gap-1.5">
            {items.map((o, i) => (
              <span key={o.id} className={`h-1.5 rounded-full transition-all duration-500 ${i === index ? 'w-6 bg-white' : 'w-1.5 bg-white/30'}`} />
            ))}
          </div>
        )}
      </div>

      <div className="relative mt-6 h-[200px]">
        {!loaded ? (
          <div className="h-full animate-pulse rounded-2xl bg-white/5" />
        ) : item ? (
          <div key={item.id} className="card-in absolute inset-0">
            <ComingUpItem item={item} tz={tz} now={now} />
          </div>
        ) : (
          <div className="flex h-full flex-col items-start justify-center gap-3 text-white/70">
            <PartyPopper size={40} className="text-alexa" />
            <div className="text-[26px] font-medium text-white">All clear</div>
            <div className="text-[19px]">Nothing due in the next month.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function ComingUpItem({ item, tz, now }: { item: Obligation; tz: string; now: number }) {
  const w = when(item.dueDate, tz, now);
  const amount = money(item.amount, item.currency);
  const overdue = isOverdue(item, now);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-4">
        <TypeIcon type={item.type} size={56} />
        <div className="text-[18px] font-medium text-white/60">
          {TYPE_LABEL[item.type]}
          {item.forWhom && <span className="text-white/80"> · for {item.forWhom}</span>}
          {item.private && <Lock size={15} className="ml-2 inline -translate-y-px text-white/50" />}
        </div>
      </div>
      <div className="mt-5 line-clamp-2 text-[32px] font-semibold leading-[1.15] tracking-tight text-white">{item.title}</div>
      <div className="mt-auto flex items-end justify-between">
        <div className={`text-[22px] font-medium ${overdue ? 'text-rose-300' : 'text-alexa'}`}>
          {overdue ? 'Overdue' : w.day}
          {w.time && <span className="text-white/60"> · {w.time}</span>}
        </div>
        {amount && <div className="text-[26px] font-semibold tabular-nums text-white">{amount}</div>}
      </div>
    </div>
  );
}

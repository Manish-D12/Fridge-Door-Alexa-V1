import { useState } from 'react';
import type { AgentCard, GetSourceResult, IngestResult, Obligation, WhatsDueResult } from '@fridge-door/shared';
import { CalendarCheck, CircleAlert, CircleCheck, CircleHelp, Lock, Quote, ShieldCheck, Sparkles } from 'lucide-react';
import { ago, isOverdue, money, plainDate, SOURCE_NOUN, TYPE_LABEL, when, whenText } from '../format';
import { SOURCE_ICON, TypeIcon } from './TypeIcon';

export interface CardActions {
  /** Pick a date for an item flagged needsConfirmation. */
  confirm(id: string, date: string): void;
  /** Say something on the user's behalf (tapping a choice). */
  say(text: string): void;
}

export function Card({ card, tz, now, actions }: { card: AgentCard; tz: string; now: number; actions: CardActions }) {
  switch (card.kind) {
    case 'due':
      return <DueCard result={card.result} now={now} />;
    case 'item':
      return <ItemCard heading={card.heading} item={card.item} tz={tz} now={now} />;
    case 'source':
      return <SourceCard result={card.result} item={card.item} tz={tz} now={now} />;
    case 'ingest':
      return <IngestCard result={card.result} tz={tz} now={now} actions={actions} />;
    case 'choices':
      return (
        <Panel icon={<CircleHelp size={20} />} heading={card.heading}>
          <div className="flex flex-col gap-2">
            {card.candidates.map((c) => (
              <button
                key={c.id}
                onClick={() => actions.say(`The ${c.title} due ${whenText(c.dueDate, tz, now).replace(' · ', ' at ')}`)}
                className="flex items-center justify-between rounded-2xl bg-white/[0.06] px-5 py-4 text-left transition hover:bg-white/[0.12] active:scale-[0.99]"
              >
                <span className="text-[22px] font-medium">{c.title}</span>
                <span className="text-[19px] text-alexa">{whenText(c.dueDate, tz, now)}</span>
              </button>
            ))}
          </div>
        </Panel>
      );
  }
}

// ---------------------------------------------------------------------------

function Panel({ icon, heading, aside, children }: { icon: React.ReactNode; heading: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="glass flex max-h-full flex-col rounded-[30px] p-7">
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-2.5 text-[16px] font-semibold uppercase tracking-[0.16em] text-alexa">
          {icon}
          {heading}
        </div>
        {aside}
      </div>
      <div className="no-scrollbar -mx-1 min-h-0 overflow-y-auto px-1">{children}</div>
    </div>
  );
}

const RANGE_HEADING: Record<WhatsDueResult['range'], string> = {
  today: 'Due today',
  tomorrow: 'Due tomorrow',
  week: 'Due this week',
  month: 'Due this month',
};

function DueCard({ result, now }: { result: WhatsDueResult; now: number }) {
  const tz = result.timeZone;
  const total = result.items.length + result.overdue.length;
  const heading = `${RANGE_HEADING[result.range]}${result.forWhom ? ` · ${result.forWhom}` : ''}`;
  return (
    <Panel icon={<CalendarCheck size={20} />} heading={heading} aside={<span className="text-[17px] text-white/50">{total} {total === 1 ? 'item' : 'items'}</span>}>
      {total === 0 ? (
        <div className="flex items-center gap-3 py-6 text-[22px] text-white/70">
          <Sparkles className="text-alexa" /> Nothing due. Enjoy the quiet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {result.overdue.map((o) => (
            <Row key={o.id} item={o} tz={tz} now={now} />
          ))}
          {result.items.map((o) => (
            <Row key={o.id} item={o} tz={tz} now={now} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function Row({ item, tz, now, badge }: { item: Obligation; tz: string; now: number; badge?: React.ReactNode }) {
  const w = when(item.dueDate, tz, now);
  const amount = money(item.amount, item.currency);
  const overdue = isOverdue(item, now);
  const done = item.status === 'done';
  return (
    <div className={`flex items-center gap-4 rounded-2xl px-4 py-3 ${overdue ? 'bg-rose-500/10 ring-1 ring-rose-400/25' : 'bg-white/[0.045]'}`}>
      <TypeIcon type={item.type} size={46} />
      <div className="min-w-0 flex-1">
        <div className={`truncate text-[22px] font-medium leading-tight ${done ? 'text-white/50 line-through decoration-white/30' : ''}`}>{item.title}</div>
        <div className="mt-1 flex items-center gap-2 text-[16px] text-white/55">
          {item.forWhom && <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-white/80">{item.forWhom}</span>}
          {item.private && (
            <span className="inline-flex items-center gap-1">
              <Lock size={13} /> Only you
            </span>
          )}
          {done && item.doneBy && <span className="text-emerald-300">Done by {item.doneBy}</span>}
          {!item.forWhom && !item.private && !done && <span>{TYPE_LABEL[item.type]}</span>}
          {badge}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className={`text-[19px] font-medium ${overdue ? 'text-rose-300' : 'text-white/90'}`}>
          {overdue ? 'Overdue' : w.day}
          {w.time && <span className="text-white/55"> · {w.time}</span>}
        </div>
        {amount && <div className="mt-0.5 text-[20px] font-semibold tabular-nums text-white">{amount}</div>}
      </div>
    </div>
  );
}

function ItemCard({ heading, item, tz, now }: { heading: string; item: Obligation; tz: string; now: number }) {
  const w = when(item.dueDate, tz, now);
  const amount = money(item.amount, item.currency);
  const done = item.status === 'done';
  return (
    <Panel icon={done ? <CircleCheck size={20} /> : <CalendarCheck size={20} />} heading={heading}>
      <div className="flex items-start gap-6">
        <TypeIcon type={item.type} size={84} />
        <div className="min-w-0 flex-1">
          <div className="text-[17px] font-medium text-white/55">
            {TYPE_LABEL[item.type]}
            {item.forWhom && <span className="text-white/80"> · for {item.forWhom}</span>}
          </div>
          <div className="mt-1 text-[38px] font-semibold leading-tight tracking-tight">{item.title}</div>
          <div className="mt-3 flex items-baseline gap-5">
            <span className="text-[24px] text-alexa">
              {w.day}
              {w.time && <span className="text-white/60"> · {w.time}</span>}
            </span>
            {amount && <span className="text-[28px] font-semibold tabular-nums">{amount}</span>}
          </div>
        </div>
      </div>
      <div className={`mt-6 flex items-center gap-3 rounded-2xl px-5 py-4 text-[20px] ${done ? 'bg-emerald-400/12 text-emerald-200' : 'bg-white/[0.05] text-white/70'}`}>
        {done ? <CircleCheck size={24} className="text-emerald-300" /> : <CircleAlert size={24} className="text-white/50" />}
        {done ? (
          <span>
            Handled by <b className="font-semibold text-white">{item.doneBy ?? 'someone'}</b>
            {item.doneAt && <span className="text-emerald-200/70"> · {ago(item.doneAt, now)}</span>}
          </span>
        ) : (
          <span>Not done yet · added by {item.addedBy}</span>
        )}
      </div>
    </Panel>
  );
}

function SourceCard({ result, item, tz, now }: { result: GetSourceResult; item: Obligation | null; tz: string; now: number }) {
  const Icon = SOURCE_ICON[result.source];
  const noun = SOURCE_NOUN[result.source];
  return (
    <Panel icon={<Quote size={20} />} heading={result.title}>
      {item && (
        <div className="mb-5 flex items-center gap-4">
          <TypeIcon type={item.type} size={48} />
          <div className="text-[21px]">
            <span className="text-alexa">{whenText(item.dueDate, tz, now)}</span>
            {item.amount !== null && <span className="ml-3 font-semibold tabular-nums">{money(item.amount, item.currency)}</span>}
            {item.forWhom && <span className="ml-3 text-white/60">for {item.forWhom}</span>}
          </div>
        </div>
      )}
      <div className="overflow-hidden rounded-2xl bg-[#f6f3ea] text-[#1f2430] shadow-inner">
        <div className="flex items-center gap-2.5 border-b border-black/10 bg-black/[0.04] px-5 py-3 text-[16px] font-semibold uppercase tracking-[0.12em] text-[#5b6170]">
          <Icon size={18} /> From your {noun}
        </div>
        <blockquote className="whitespace-pre-wrap px-6 py-5 font-serif text-[22px] leading-relaxed">{result.sourceSnippet}</blockquote>
      </div>
      <div className="mt-4 flex items-center gap-2 text-[16px] text-white/50">
        <ShieldCheck size={15} /> Quoted exactly · added by {result.addedBy} · {ago(result.createdAt, now)}
      </div>
    </Panel>
  );
}

function IngestCard({ result, tz, now, actions }: { result: IngestResult; tz: string; now: number; actions: CardActions }) {
  const Icon = SOURCE_ICON[result.source];
  const duplicates = result.skipped.filter((s) => s.reason === 'duplicate');
  const pending = new Set(result.needsConfirmation.map((n) => n.id));
  const heading =
    result.items.length === 0 ? 'Nothing new found' : `Found ${result.items.length} ${result.items.length === 1 ? 'thing' : 'things'}`;
  return (
    <Panel icon={<Icon size={20} />} heading={heading} aside={<span className="text-[16px] text-white/50">from your {SOURCE_NOUN[result.source]}</span>}>
      <div className="flex flex-col gap-3">
        {result.needsConfirmation.map((n) => (
          <ConfirmBlock key={n.id} question={n.question} options={n.options} onPick={(d) => actions.confirm(n.id, d)} />
        ))}
        {result.items.map((o) => (
          <Row
            key={o.id}
            item={o}
            tz={tz}
            now={now}
            badge={
              pending.has(o.id) ? (
                <span className="rounded-full bg-amber-300/15 px-2.5 py-0.5 text-amber-200">Needs checking</span>
              ) : (
                <span className="text-emerald-300">Added</span>
              )
            }
          />
        ))}
        {duplicates.length > 0 && (
          <div className="flex items-center gap-2 px-2 pt-1 text-[17px] text-white/50">
            <CircleCheck size={17} /> Already on the list: {duplicates.map((d) => d.title).join(', ')}
          </div>
        )}
      </div>
    </Panel>
  );
}

function ConfirmBlock({ question, options, onPick }: { question: string; options: string[]; onPick(date: string): void }) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="rounded-2xl bg-gradient-to-br from-amber-300/15 to-orange-400/5 p-5 ring-1 ring-amber-300/25">
      <div className="flex items-start gap-3 text-[22px] font-medium leading-snug">
        <CircleHelp size={26} className="mt-0.5 shrink-0 text-amber-200" />
        {question}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {options.map((d) => (
          <button
            key={d}
            disabled={picked !== null}
            onClick={() => {
              setPicked(d);
              onPick(d);
            }}
            className={`rounded-2xl px-5 py-4 text-[24px] font-semibold transition active:scale-[0.98] disabled:cursor-default ${
              picked === d ? 'bg-alexa text-slate-950' : 'bg-white/10 hover:bg-white/20 disabled:opacity-40'
            }`}
          >
            {plainDate(d)}
          </button>
        ))}
      </div>
    </div>
  );
}

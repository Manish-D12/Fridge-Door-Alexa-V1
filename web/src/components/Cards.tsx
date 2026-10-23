import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type {
  ActionLink,
  AgentCard,
  FollowupDraft,
  GetSourceResult,
  IngestResult,
  Obligation,
  ObligationAction,
  SyncInboxResult,
  WhatsDueResult,
} from '@fridge-door/shared';
import {
  CalendarCheck,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  ExternalLink,
  Hourglass,
  Lock,
  Mail,
  MailCheck,
  Quote,
  RefreshCw,
  Reply,
  Send,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import { ago, isOverdue, money, plainDate, SOURCE_NOUN, TYPE_LABEL, when, whenText } from '../format';
import { SOURCE_ICON, TypeIcon } from './TypeIcon';

export interface CardActions {
  /** Pick a date for an item flagged needsConfirmation. */
  confirm(id: string, date: string): void;
  /** Say something on the user's behalf (tapping a choice). */
  say(text: string): void;
  /** The Send button: `body` only when it was edited. */
  send(draftId: string, body: string | undefined): void;
  discard(draftId: string): void;
  markDone(id: string): void;
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
    case 'draft':
      return <DraftCard draft={card.draft} actions={actions} />;
    case 'sent':
      return <SentCard draft={card.draft} item={card.item} demo={card.delivery === 'demo_outbox'} now={now} />;
    case 'renewal':
      return <RenewalCard item={card.item} link={card.link} tz={tz} now={now} actions={actions} />;
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
      <ScrollArea>{children}</ScrollArea>
    </div>
  );
}

/** Scrolls without a scrollbar, fading out the bottom edge while there is more below. */
function ScrollArea({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    el.addEventListener('scroll', check, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', check);
    };
  }, []);
  return (
    <div
      ref={ref}
      className="no-scrollbar -mx-1 min-h-0 overflow-y-auto px-1 transition-[mask-image]"
      style={more ? { maskImage: 'linear-gradient(to bottom, black calc(100% - 56px), transparent)' } : undefined}
    >
      {children}
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
          <StatusPill status={item.status} />
          {!item.forWhom && !item.private && item.status === 'pending' && <span>{TYPE_LABEL[item.type]}</span>}
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
        ) : item.status === 'awaiting_reply' ? (
          <span>Waiting for a reply{item.email?.fromName ? ` from ${item.email.fromName}` : ''}</span>
        ) : item.status === 'renewal_in_progress' ? (
          <span>Renewal in progress · tap Mark renewed when it’s done</span>
        ) : (
          <span>Not done yet · added by {item.addedBy}</span>
        )}
      </div>
      <Timeline actions={item.actions} now={now} />
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
      <Timeline actions={result.actions} now={now} />
    </Panel>
  );
}

function IngestCard({ result, tz, now, actions }: { result: IngestResult; tz: string; now: number; actions: CardActions }) {
  const Icon = SOURCE_ICON[result.source];
  const duplicates = result.skipped.filter((s) => s.reason === 'duplicate');
  const pending = new Set(result.needsConfirmation.map((n) => n.id));
  const heading =
    result.items.length === 0 ? 'Nothing new found' : `Found ${result.items.length} ${result.items.length === 1 ? 'thing' : 'things'}`;
  // An inbox sync (sync_inbox) says how many emails it read.
  const emails = (result as Partial<SyncInboxResult>).emails;
  const from = emails ? `from ${emails.read} new email${emails.read === 1 ? '' : 's'}` : `from your ${SOURCE_NOUN[result.source]}`;
  return (
    <Panel icon={<Icon size={20} />} heading={heading} aside={<span className="text-[16px] text-white/50">{from}</span>}>
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

// ---------------------------------------------------------------------------
// Follow-up actions
// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: Obligation['status'] }) {
  if (status === 'awaiting_reply') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-300/15 px-2.5 py-0.5 text-sky-200">
        <Hourglass size={13} /> Waiting for reply
      </span>
    );
  }
  if (status === 'renewal_in_progress') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-violet-300/15 px-2.5 py-0.5 text-violet-200">
        <RefreshCw size={13} /> Renewing
      </span>
    );
  }
  return null;
}

const ACTION_ICON: Record<ObligationAction['type'], React.ReactNode> = {
  email_sent: <Send size={16} />,
  reply_received: <Reply size={16} />,
  renewal_started: <RefreshCw size={16} />,
};

/** What has been done about an item, oldest first. */
function Timeline({ actions, now }: { actions: ObligationAction[]; now: number }) {
  if (actions.length === 0) return null;
  return (
    <div className="mt-5">
      <div className="mb-2 text-[14px] font-semibold uppercase tracking-[0.14em] text-white/40">History</div>
      <ol className="relative ml-3 border-l border-white/15">
        {actions.map((a, i) => (
          <li key={`${a.at}-${i}`} className="relative pb-3 pl-6 last:pb-0">
            <span className="absolute -left-[13px] top-0.5 flex size-[26px] items-center justify-center rounded-full bg-[#1b2438] text-alexa ring-1 ring-white/15">
              {ACTION_ICON[a.type]}
            </span>
            <div className="text-[18px] leading-snug text-white/85">
              <b className="font-semibold text-white">{a.by}</b> {a.summary}
            </div>
            <div className="text-[14px] text-white/45">{ago(a.at, now)}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function DraftCard({ draft, actions }: { draft: FollowupDraft; actions: CardActions }) {
  const [body, setBody] = useState(draft.body);
  const [done, setDone] = useState<'sent' | 'cancelled' | null>(null);
  const edited = body.trim() !== draft.body;
  return (
    <Panel
      icon={<Mail size={20} />}
      heading="Draft reply"
      aside={<span className="rounded-full bg-amber-300/15 px-3 py-1 text-[15px] font-medium text-amber-200">Not sent yet</span>}
    >
      <div className="overflow-hidden rounded-2xl bg-[#f6f3ea] text-[#1f2430]">
        <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 border-b border-black/10 bg-black/[0.04] px-5 py-3 text-[17px]">
          <dt className="font-semibold uppercase tracking-[0.1em] text-[#5b6170]">To</dt>
          <dd className="min-w-0 truncate">
            {draft.toName && <span className="font-semibold">{draft.toName} </span>}
            <span className="text-[#5b6170]">&lt;{draft.to}&gt;</span>
          </dd>
          <dt className="font-semibold uppercase tracking-[0.1em] text-[#5b6170]">Subject</dt>
          <dd className="min-w-0 truncate">{draft.subject}</dd>
        </dl>
        <textarea
          aria-label="Email body"
          value={body}
          disabled={done !== null}
          onChange={(e) => setBody(e.target.value)}
          rows={7}
          className="block w-full resize-none bg-transparent px-5 py-4 font-serif text-[20px] leading-relaxed outline-none focus:bg-white/60 disabled:opacity-70"
        />
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          disabled={done !== null || !body.trim()}
          onClick={() => {
            setDone('sent');
            actions.send(draft.id, edited ? body.trim() : undefined);
          }}
          className="inline-flex items-center gap-2 rounded-full bg-alexa px-7 py-3.5 text-[21px] font-semibold text-slate-950 transition hover:brightness-110 active:scale-95 disabled:opacity-40"
        >
          <Send size={20} /> Send
        </button>
        <button
          disabled={done !== null}
          onClick={() => {
            setDone('cancelled');
            actions.discard(draft.id);
          }}
          className="rounded-full bg-white/10 px-6 py-3.5 text-[21px] font-medium text-white/85 transition hover:bg-white/20 active:scale-95 disabled:opacity-40"
        >
          Cancel
        </button>
        <span className="ml-auto text-right text-[15px] leading-snug text-white/50">
          {draft.demo ? 'Sample item: goes to the demo outbox' : edited ? 'Your edits will be sent' : 'Or say “send it”'}
        </span>
      </div>
    </Panel>
  );
}

function SentCard({ draft, item, demo, now }: { draft: FollowupDraft; item: Obligation; demo: boolean; now: number }) {
  return (
    <Panel icon={<MailCheck size={20} />} heading={demo ? 'Saved to demo outbox' : 'Sent'}>
      <div className="flex items-center gap-5">
        <span className="pop-in flex size-[76px] shrink-0 items-center justify-center rounded-full bg-emerald-400/20 text-emerald-300 ring-1 ring-emerald-300/40">
          <CircleCheck size={44} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[28px] font-semibold leading-tight">{demo ? 'Saved, not sent' : 'Sent'}</div>
          <div className="truncate text-[21px] text-emerald-200" title={draft.to}>
            {demo ? 'Reply to ' : 'To '}
            {draft.to}
          </div>
          <div className="mt-1 text-[19px] text-white/65">
            {demo ? 'This is sample data, so nothing left Gmail.' : item.status === 'awaiting_reply' ? "I'll watch for their reply." : 'In the same email thread.'}
          </div>
        </div>
      </div>
      <div className="mt-5 rounded-2xl bg-white/[0.05] px-5 py-4">
        <div className="truncate text-[17px] font-medium text-white/80">{draft.subject}</div>
        <div className="mt-1 line-clamp-3 whitespace-pre-line text-[17px] leading-snug text-white/50">{draft.body}</div>
      </div>
      <Timeline actions={item.actions} now={now} />
    </Panel>
  );
}

function RenewalCard({ item, link, tz, now, actions }: { item: Obligation; link: ActionLink; tz: string; now: number; actions: CardActions }) {
  const [qr, setQr] = useState<string | null>(null);
  const [marked, setMarked] = useState(item.status === 'done');
  useEffect(() => {
    let live = true;
    QRCode.toString(link.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b1020', light: '#ffffff' } })
      .then((svg) => live && setQr(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`))
      .catch(() => live && setQr(null));
    return () => {
      live = false;
    };
  }, [link.url]);
  const host = new URL(link.url).hostname.replace(/^www\./, '');
  const amount = money(item.amount, item.currency);
  return (
    <Panel icon={<RefreshCw size={20} />} heading="Renew on your phone">
      <div className="flex items-start gap-7">
        <div className="flex size-[232px] shrink-0 items-center justify-center rounded-3xl bg-white p-3 shadow-xl">
          {qr ? <img src={qr} alt={`QR code for ${host}`} className="size-full" /> : <span className="text-[15px] text-slate-500">Making code…</span>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[30px] font-semibold leading-tight tracking-tight">{item.title}</div>
          <div className="mt-2 flex items-baseline gap-4 text-[21px]">
            <span className="text-alexa">Due {whenText(item.dueDate, tz, now)}</span>
            {amount && <span className="font-semibold tabular-nums">{amount}</span>}
          </div>
          <div className="mt-3 flex items-center gap-2 text-[17px] text-white/60">
            <ShieldCheck size={16} className="text-emerald-300" /> {host} · from the original email
          </div>
          <p className="mt-3 text-[16px] leading-snug text-white/50">Scan to finish on your phone. Alexa can’t renew or pay for you.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full bg-white/10 px-5 py-3 text-[18px] font-medium text-white/90 transition hover:bg-white/20 active:scale-95"
            >
              <Smartphone size={19} /> Open on phone <ExternalLink size={15} className="text-white/50" />
            </a>
            <button
              disabled={marked}
              onClick={() => {
                setMarked(true);
                actions.markDone(item.id);
              }}
              className="inline-flex items-center gap-2 rounded-full bg-alexa px-5 py-3 text-[18px] font-semibold text-slate-950 transition hover:brightness-110 active:scale-95 disabled:opacity-40"
            >
              <CircleCheck size={19} /> {marked ? 'Marked renewed' : 'Mark renewed'}
            </button>
          </div>
        </div>
      </div>
    </Panel>
  );
}

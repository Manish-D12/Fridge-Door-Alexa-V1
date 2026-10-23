import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentActionInput, AgentCard, AgentReply, Obligation } from '@fridge-door/shared';
import { Camera, ChevronDown, CircleAlert, Keyboard, Mic, SendHorizontal, Wifi, X } from 'lucide-react';
import { api, API_URL } from './api';
import { Card, type CardActions } from './components/Cards';
import { CameraSheet, type Photo } from './components/CameraSheet';
import { Device } from './components/Device';
import { IdleScreen } from './components/IdleScreen';
import { LightBar, type Phase } from './components/LightBar';
import { SettingsMenu } from './components/Settings';
import { clock } from './format';
import { loadMemberIndex, MEMBERS, saveMemberIndex } from './members';
import { earcon, speak, stopSpeaking, useRecognition } from './voice';

const DEFAULT_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Back to the clock this long after Alexa finishes speaking. */
const DISMISS_MS = 25_000;
/** A press shorter than this is a tap (listen until silence) rather than push-to-talk. */
const TAP_MS = 300;

const EXAMPLES = [
  "What's due this week?",
  'I paid the water bill',
  'What did the school notice say?',
  'Check my email',
  "Ask the dentist to move Maya's appointment to Thursday",
  'Renew the car insurance',
];

interface Exchange {
  /** What the person said, or null for a photo. */
  heard: string | null;
  photo: string | null;
  reply: AgentReply | null;
  error: string | null;
}

export default function App() {
  const [memberIndex, setMemberIndex] = useState(loadMemberIndex);
  const member = MEMBERS[memberIndex]!;
  const [phase, setPhase] = useState<Phase>('idle');
  const [interim, setInterim] = useState('');
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [tz, setTz] = useState(DEFAULT_TZ);
  const [comingUp, setComingUp] = useState<{ items: Obligation[]; loaded: boolean }>({ items: [], loaded: false });
  const [offline, setOffline] = useState(false);
  const session = useRef<string | undefined>(undefined);
  /** Numbers each request; only the newest may change the screen, so a slow reply can't replace a newer one. */
  const latest = useRef(0);
  const dismissTimer = useRef<number | undefined>(undefined);
  const memberRef = useRef(member.name);
  memberRef.current = member.name;

  // --- Idle screen data -----------------------------------------------------

  const refresh = useCallback(async () => {
    try {
      const r = await api.comingUp(memberRef.current);
      setTz(r.timeZone);
      setComingUp({ items: [...r.overdue, ...r.items].filter((o) => o.status !== 'done').slice(0, 3), loaded: true });
      setOffline(false);
    } catch {
      setOffline(true);
      setComingUp((c) => ({ ...c, loaded: true }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(t);
  }, [refresh, member.name]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, []);

  // --- Conversation ---------------------------------------------------------

  const clearDismiss = () => window.clearTimeout(dismissTimer.current);

  const dismiss = useCallback(() => {
    latest.current++;
    clearDismiss();
    stopSpeaking();
    setExchange(null);
    setPhase('idle');
  }, []);

  const say = useCallback((text: string, keepOpen: boolean) => {
    setPhase('speaking');
    speak(text, () => {
      setPhase((p) => (p === 'speaking' ? 'idle' : p));
      clearDismiss();
      if (!keepOpen) dismissTimer.current = window.setTimeout(dismiss, DISMISS_MS);
    });
  }, [dismiss]);

  const present = useCallback(
    (reply: AgentReply) => {
      session.current = reply.sessionId;
      setExchange((e) => ({ heard: e?.heard ?? null, photo: e?.photo ?? null, reply, error: null }));
      setNow(Date.now());
      void refresh();
      say(reply.speech, waitsForPerson(reply.card));
    },
    [refresh, say],
  );

  const fail = useCallback(
    (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Something went wrong.';
      setExchange((e) => ({ heard: e?.heard ?? null, photo: e?.photo ?? null, reply: null, error: message }));
      say(message, false);
    },
    [say],
  );

  const ask = useCallback(
    async (text: string) => {
      const turn = ++latest.current;
      clearDismiss();
      stopSpeaking();
      setInterim('');
      setExchange({ heard: text, photo: null, reply: null, error: null });
      setPhase('thinking');
      try {
        const reply = await api.chat(memberRef.current, text, session.current);
        if (turn === latest.current) present(reply);
      } catch (err) {
        if (turn === latest.current) fail(err);
      }
    },
    [present, fail],
  );

  const sendPhoto = useCallback(
    async (photo: Photo) => {
      const turn = ++latest.current;
      setCameraOpen(false);
      clearDismiss();
      stopSpeaking();
      setExchange({ heard: null, photo: photo.previewUrl, reply: null, error: null });
      setPhase('thinking');
      try {
        const reply = await api.action(memberRef.current, {
          tool: 'ingest_image',
          arguments: { base64: photo.base64, mimeType: photo.mimeType },
          sessionId: session.current,
        });
        if (turn === latest.current) present(reply);
      } catch (err) {
        if (turn === latest.current) fail(err);
      }
    },
    [present, fail],
  );

  const confirm = useCallback(
    async (id: string, date: string) => {
      const turn = ++latest.current;
      clearDismiss();
      stopSpeaking();
      setPhase('thinking');
      try {
        const reply = await api.action(memberRef.current, { tool: 'confirm_item', arguments: { id, chosenDate: date }, sessionId: session.current });
        if (turn !== latest.current) return;
        session.current = reply.sessionId;
        // Fold the answer into the card on screen, so other questions stay answerable.
        let remaining = 0;
        setExchange((e) => {
          const card = foldConfirmation(e?.reply?.card ?? null, id, reply.card);
          remaining = card?.kind === 'ingest' ? card.result.needsConfirmation.length : 0;
          return { heard: e?.heard ?? null, photo: e?.photo ?? null, error: null, reply: { ...reply, card: card ?? reply.card } };
        });
        void refresh();
        say(reply.speech, remaining > 0);
      } catch (err) {
        if (turn === latest.current) fail(err);
      }
    },
    [refresh, say, fail],
  );

  /** A button on a card: straight to an MCP tool, no model. */
  const act = useCallback(
    async (input: AgentActionInput) => {
      const turn = ++latest.current;
      clearDismiss();
      stopSpeaking();
      setPhase('thinking');
      try {
        const reply = await api.action(memberRef.current, { ...input, sessionId: session.current });
        if (turn === latest.current) present(reply);
      } catch (err) {
        if (turn === latest.current) fail(err);
      }
    },
    [present, fail],
  );

  const actions: CardActions = {
    confirm: (id, d) => void confirm(id, d),
    say: (t) => void ask(t),
    send: (draftId, body) => void act({ tool: 'send_followup', arguments: { draftId, confirmedBy: memberRef.current, ...(body === undefined ? {} : { body }) } }),
    discard: (draftId) => void act({ tool: 'discard_draft', arguments: { draftId } }),
    markDone: (id) => void act({ tool: 'mark_done', arguments: { idOrTitle: id, doneBy: memberRef.current } }),
  };

  // --- Voice ----------------------------------------------------------------

  const rec = useRecognition({
    onInterim: setInterim,
    onFinal: (text) => void ask(text),
    onNothing: () => {
      setPhase((p) => (p === 'listening' ? 'idle' : p));
      setExchange((e) => (e && !e.reply && !e.error && !e.heard && !e.photo ? null : e));
    },
    onError: (message) => {
      setExchange({ heard: null, photo: null, reply: null, error: message });
      say(message, false);
    },
  });

  const [typing, setTyping] = useState(!rec.supported);
  const pressedAt = useRef(0);

  const startListening = useCallback(() => {
    if (!rec.supported) {
      setTyping(true);
      return;
    }
    if (rec.listening) return;
    latest.current++;
    clearDismiss();
    stopSpeaking();
    earcon();
    setInterim('');
    setExchange({ heard: null, photo: null, reply: null, error: null });
    setPhase('listening');
    rec.start();
  }, [rec]);

  // Space bar: hold to talk.
  useEffect(() => {
    const isField = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !isField(e.target) && !cameraOpen) {
        e.preventDefault();
        startListening();
      } else if (e.code === 'Escape') {
        if (cameraOpen) setCameraOpen(false);
        else dismiss();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isField(e.target)) rec.stop();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [startListening, rec, cameraOpen, dismiss]);

  const switchMember = (i: number) => {
    if (i === memberIndex) return;
    saveMemberIndex(i);
    setMemberIndex(i);
    session.current = undefined; // a new speaker starts a new conversation
    setComingUp((c) => ({ ...c, loaded: false }));
    dismiss();
  };

  const active = exchange !== null || phase === 'listening';
  const c = clock(tz, now);

  return (
    <div className="room flex h-full flex-col items-center justify-center gap-6 px-6">
      <Device reserveBelow={92}>
        <div className="aurora absolute inset-0" />

        {/* Idle layer stays mounted and recedes behind responses. */}
        <div
          className={`absolute inset-0 transition-all duration-500 ease-out-soft ${active ? 'scale-[0.97] opacity-0 blur-md' : 'opacity-100'}`}
          aria-hidden={active}
        >
          <IdleScreen items={comingUp.items} loaded={comingUp.loaded} tz={tz} now={now} />
        </div>

        <div className={`absolute inset-0 transition-opacity duration-500 ${active ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
          {active && <ResponseView phase={phase} interim={interim} exchange={exchange} tz={tz} now={now} actions={actions} />}
        </div>

        {/* Status bar */}
        <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-9 pt-6 text-[19px] text-white/70">
          <div className={`font-medium transition-opacity duration-500 ${active ? 'opacity-100' : 'opacity-0'}`}>
            {c.time} <span className="text-white/45">{c.period}</span>
          </div>
          <div className="flex items-center gap-4">
            {offline && (
              <span className="flex items-center gap-1.5 rounded-full bg-rose-500/20 px-3 py-1 text-[15px] text-rose-200">
                <CircleAlert size={15} /> Server offline
              </span>
            )}
            <Wifi size={20} className="text-white/55" />
            <SettingsMenu member={member.name} />
            <MemberSwitcher index={memberIndex} onChange={switchMember} />
          </div>
        </div>

        {/* Dock */}
        <div className="absolute bottom-9 right-9 z-20 flex items-center gap-3">
          <DockButton label="Type instead" onClick={() => setTyping((t) => !t)} active={typing}>
            <Keyboard size={24} />
          </DockButton>
          <DockButton label="Show a document" onClick={() => setCameraOpen(true)}>
            <Camera size={24} />
          </DockButton>
          <button
            aria-label={rec.supported ? 'Hold to talk' : 'Speech input not supported; type instead'}
            title={rec.supported ? 'Hold to talk (or hold Space)' : 'This browser has no speech recognition. Type instead.'}
            onPointerDown={(e) => {
              e.preventDefault();
              pressedAt.current = Date.now();
              if (rec.listening) rec.stop();
              else startListening();
            }}
            onPointerUp={() => {
              if (Date.now() - pressedAt.current > TAP_MS) rec.stop();
            }}
            className={`flex size-[72px] items-center justify-center rounded-full shadow-xl transition-all duration-300 active:scale-95 ${
              phase === 'listening'
                ? 'bg-alexa text-slate-950 shadow-[0_0_40px_rgba(0,202,255,0.6)]'
                : 'bg-gradient-to-b from-[#2b6ff2] to-[#1d3e8f] text-white shadow-black/40 hover:brightness-110'
            } ${rec.supported ? '' : 'opacity-50'}`}
          >
            <Mic size={32} strokeWidth={2.2} />
          </button>
        </div>

        {typing && <TypeBox onSend={(t) => void ask(t)} onClose={() => setTyping(false)} />}
        {cameraOpen && <CameraSheet onPhoto={(p) => void sendPhoto(p)} onClose={() => setCameraOpen(false)} />}
        <LightBar phase={phase} />
      </Device>

      {/* Simulator controls, outside the device */}
      <div className="flex max-w-[1100px] flex-wrap items-center justify-center gap-x-5 gap-y-3 text-[14px] text-white/45">
        <span className="flex items-center gap-2">
          <kbd className="rounded-md border border-white/15 bg-white/5 px-2 py-0.5 font-sans text-white/70">Space</kbd> hold to talk
        </span>
        <span className="h-4 w-px bg-white/10" />
        <span>Try:</span>
        {EXAMPLES.map((x) => (
          <button key={x} onClick={() => void ask(x)} className="rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-white/70 transition hover:border-white/25 hover:text-white">
            {x}
          </button>
        ))}
        <span className="h-4 w-px bg-white/10" />
        <span title={API_URL}>Speaking as {member.label}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Cards that wait for a tap or an answer stay up instead of returning to the clock. */
function waitsForPerson(card: AgentCard | null): boolean {
  if (card?.kind === 'ingest') return card.result.needsConfirmation.length > 0;
  return card?.kind === 'draft' || card?.kind === 'renewal';
}

/** After confirm_item, update the ingest card in place instead of replacing it. */
function foldConfirmation(card: AgentCard | null, id: string, confirmed: AgentCard | null): AgentCard | null {
  if (card?.kind !== 'ingest' || confirmed?.kind !== 'item') return null;
  const result = card.result;
  return {
    kind: 'ingest',
    result: {
      ...result,
      items: result.items.map((o) => (o.id === id ? confirmed.item : o)),
      needsConfirmation: result.needsConfirmation.filter((n) => n.id !== id),
    },
  };
}

function ResponseView({ phase, interim, exchange, tz, now, actions }: { phase: Phase; interim: string; exchange: Exchange | null; tz: string; now: number; actions: CardActions }) {
  if (phase === 'listening' && !exchange?.heard) {
    return (
      <div className="flex h-full flex-col justify-center px-[92px] pb-12">
        <div className="text-[22px] font-medium uppercase tracking-[0.2em] text-alexa">Listening</div>
        <div className="mt-5 max-w-[1000px] text-[58px] font-light leading-[1.15] tracking-tight text-white">
          {interim || <span className="text-white/35">Go ahead…</span>}
        </div>
      </div>
    );
  }

  const reply = exchange?.reply ?? null;
  const card = reply?.card ?? null;
  const thinking = phase === 'thinking' && !reply && !exchange?.error;
  const tools = reply?.toolCalls.map((t) => t.name) ?? [];

  return (
    <div className={`grid h-full items-center gap-12 px-[72px] pb-[124px] pt-[96px] ${card ? 'grid-cols-[400px_1fr]' : 'grid-cols-1'}`}>
      <div className={card ? '' : 'max-w-[1000px]'}>
        {exchange?.heard && <div className="rise-in text-[22px] font-light leading-snug text-white/55">“{exchange.heard}”</div>}
        {exchange?.photo && thinking && <PhotoScan src={exchange.photo} />}
        {thinking && (
          <div className="mt-6 flex gap-2" aria-label="Thinking">
            {[0, 1, 2].map((i) => (
              <span key={i} className="dot size-3 rounded-full bg-alexa" style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </div>
        )}
        {reply && (
          <div key={reply.speech} className={`rise-in mt-4 font-normal leading-[1.25] tracking-tight text-white ${captionSize(reply.speech, card !== null)}`}>
            {reply.speech}
          </div>
        )}
        {exchange?.error && (
          <div className="rise-in mt-4 flex items-start gap-3 text-[30px] leading-snug text-rose-100">
            <CircleAlert size={32} className="mt-1 shrink-0 text-rose-300" />
            {exchange.error}
          </div>
        )}
        {tools.length > 0 && (
          <div className="fade-in mt-6 inline-flex items-center gap-2 rounded-full bg-white/[0.06] px-3.5 py-1.5 font-mono text-[14px] text-white/45">
            <span className="size-1.5 rounded-full bg-emerald-400" /> MCP · {tools.join(' → ')}
          </div>
        )}
      </div>
      {card && (
        <div key={`${reply!.sessionId}-${reply!.speech}`} className="card-in flex h-full max-h-full min-h-0 min-w-0 flex-col justify-center">
          <Card card={card} tz={tz} now={now} actions={actions} />
        </div>
      )}
    </div>
  );
}

/** Long answers get smaller type so they never crowd the card. */
function captionSize(text: string, withCard: boolean): string {
  if (withCard) return text.length > 150 ? 'text-[24px]' : text.length > 90 ? 'text-[27px]' : 'text-[31px]';
  return text.length > 160 ? 'text-[36px]' : 'text-[46px]';
}

function PhotoScan({ src }: { src: string }) {
  return (
    <div className="rise-in">
      <div className="text-[22px] font-light text-white/55">Reading your photo…</div>
      <div className="relative mt-5 h-[260px] w-[340px] overflow-hidden rounded-2xl ring-1 ring-white/15">
        <img src={src} alt="" className="h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-alexa/10 to-transparent" />
        <div className="scanline absolute inset-x-0 h-[3px] bg-alexa shadow-[0_0_24px_6px_rgba(0,202,255,0.6)]" />
      </div>
    </div>
  );
}

function DockButton({ label, onClick, active, children }: { label: string; onClick(): void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex size-[56px] items-center justify-center rounded-full backdrop-blur-xl transition hover:bg-white/20 active:scale-95 ${
        active ? 'bg-white/25 text-white' : 'bg-white/10 text-white/80'
      }`}
    >
      {children}
    </button>
  );
}

function MemberSwitcher({ index, onChange }: { index: number; onChange(i: number): void }) {
  const [open, setOpen] = useState(false);
  const m = MEMBERS[index]!;
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2.5 rounded-full bg-white/10 py-1.5 pl-1.5 pr-3.5 backdrop-blur-xl transition hover:bg-white/15">
        <Avatar m={m} size={34} />
        <span className="text-[18px] font-medium text-white">{m.label}</span>
        <ChevronDown size={18} className={`text-white/60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="glass card-in absolute right-0 top-[54px] w-[260px] rounded-3xl p-2">
          <div className="px-4 pb-1 pt-2 text-[14px] font-semibold uppercase tracking-[0.14em] text-white/45">Who's talking?</div>
          {MEMBERS.map((x, i) => (
            <button
              key={x.name}
              onClick={() => {
                onChange(i);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition hover:bg-white/10 ${i === index ? 'bg-white/10' : ''}`}
            >
              <Avatar m={x} size={40} />
              <span>
                <span className="block text-[19px] font-medium text-white">{x.label}</span>
                {x.label !== x.name && <span className="block text-[14px] text-white/50">{x.name}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Avatar({ m, size }: { m: (typeof MEMBERS)[number]; size: number }) {
  return (
    <span className={`flex items-center justify-center rounded-full bg-gradient-to-br font-semibold text-white ${m.tint}`} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {m.initial}
    </span>
  );
}

function TypeBox({ onSend, onClose }: { onSend(text: string): void; onClose(): void }) {
  const [text, setText] = useState('');
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  };
  return (
    <div className="card-in absolute bottom-9 left-1/2 z-20 flex w-[600px] -translate-x-1/2 items-center gap-2 rounded-full bg-white/12 p-2 pl-6 shadow-2xl ring-1 ring-white/15 backdrop-blur-2xl">
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onClose();
        }}
        placeholder="Type to Alexa…"
        className="min-w-0 flex-1 bg-transparent text-[21px] text-white outline-none placeholder:text-white/40"
      />
      <button onClick={submit} aria-label="Send" className="flex size-12 items-center justify-center rounded-full bg-alexa text-slate-950 transition hover:brightness-110 active:scale-95">
        <SendHorizontal size={22} />
      </button>
      <button onClick={onClose} aria-label="Close keyboard" className="flex size-12 items-center justify-center rounded-full text-white/60 transition hover:bg-white/10">
        <X size={22} />
      </button>
    </div>
  );
}

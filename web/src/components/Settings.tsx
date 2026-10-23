import { useCallback, useEffect, useState } from 'react';
import type { GmailStatus } from '@fridge-door/shared';
import { CircleCheck, ExternalLink, Mail, Settings as SettingsIcon } from 'lucide-react';
import { api, GMAIL_CONNECT_URL } from '../api';
import { ago } from '../format';

/** The gear in the status bar: household connections. */
export function SettingsMenu({ member }: { member: string }) {
  const [open, setOpen] = useState(false);
  const [gmail, setGmail] = useState<GmailStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setGmail(await api.gmailStatus(member));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load settings.');
    }
  }, [member]);

  // Consent happens in another tab; pick up the result when this one is back in front.
  useEffect(() => {
    if (!open) return;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [open, refresh]);

  return (
    <div className="relative">
      <button
        aria-label="Settings"
        title="Settings"
        onClick={() => setOpen((o) => !o)}
        className={`flex size-[46px] items-center justify-center rounded-full backdrop-blur-xl transition hover:bg-white/15 ${open ? 'bg-white/20 text-white' : 'bg-white/10 text-white/70'}`}
      >
        <SettingsIcon size={22} />
      </button>
      {open && (
        <div className="glass card-in absolute right-0 top-[58px] w-[400px] rounded-3xl p-5">
          <div className="pb-3 text-[14px] font-semibold uppercase tracking-[0.14em] text-white/45">Settings</div>
          <div className="flex items-start gap-4 rounded-2xl bg-white/[0.06] p-4">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-rose-400 to-amber-400 text-white">
              <Mail size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[19px] font-medium text-white">Gmail</div>
              <GmailLine status={gmail} error={error} />
              {gmail?.configured && (
                <a
                  href={GMAIL_CONNECT_URL}
                  target="_blank"
                  rel="noopener"
                  className={`mt-3 inline-flex items-center gap-2 rounded-full px-4 py-2 text-[16px] font-semibold transition active:scale-95 ${
                    gmail.connected && gmail.canSend ? 'bg-white/10 text-white/80 hover:bg-white/20' : 'bg-alexa text-slate-950 hover:brightness-110'
                  }`}
                >
                  {!gmail.connected ? 'Connect Gmail' : gmail.canSend ? 'Reconnect' : 'Reconnect Gmail to enable replies'} <ExternalLink size={16} />
                </a>
              )}
            </div>
          </div>
          <p className="px-1 pt-3 text-[14px] leading-snug text-white/45">
            Reads recent mail, and sends only replies you approve on this screen. Say “Alexa, check my email” to add bills, orders and appointments from the last 14 days.
          </p>
        </div>
      )}
    </div>
  );
}

function GmailLine({ status, error }: { status: GmailStatus | null; error: string | null }) {
  const line = 'mt-0.5 text-[15px] leading-snug';
  if (error) return <div className={`${line} text-rose-200`}>{error}</div>;
  if (!status) return <div className={`${line} text-white/45`}>Checking…</div>;
  if (!status.configured) return <div className={`${line} text-white/55`}>Not set up on the server: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to server/.env.</div>;
  if (!status.connected) return <div className={`${line} text-white/55`}>Not connected</div>;
  return (
    <div className={`${line} text-white/70`}>
      <span className="flex items-center gap-1.5 text-emerald-300">
        <CircleCheck size={15} /> <span className="truncate">{status.account}</span>
      </span>
      <span className="text-white/45">{status.lastSyncAt ? `Last checked ${ago(status.lastSyncAt)}` : 'Not checked yet'}</span>
      {!status.canSend && <span className="mt-1 block text-amber-200/90">Read-only: reconnect to enable replies.</span>}
    </div>
  );
}

import type { AgentActionInput, AgentReply, GmailStatus, WhatsDueResult } from '@fridge-door/shared';

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const API_KEY: string | undefined = import.meta.env.VITE_API_KEY || undefined;
/** Opened in a new tab: the server sends it on to Google's consent page. */
export const GMAIL_CONNECT_URL = `${API_URL}/auth/google`;

export class ApiError extends Error {}

async function request<T>(path: string, member: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Household-Member': member };
  if (init.body) headers['Content-Type'] = 'application/json';
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError("I can't reach the fridge door right now. Is the server running?");
  }
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) throw new ApiError(body?.error?.message ?? `Something went wrong (${res.status}).`);
  return body as T;
}

export const api = {
  chat: (member: string, message: string, sessionId?: string) =>
    request<AgentReply>('/agent/chat', member, { method: 'POST', body: JSON.stringify({ message, sessionId }) }),

  action: (member: string, input: AgentActionInput) =>
    request<AgentReply>('/agent/action', member, { method: 'POST', body: JSON.stringify(input) }),

  /** Everything pending in the next 30 days plus anything overdue, for the idle screen. */
  comingUp: (member: string) => request<WhatsDueResult>('/api/obligations/due?range=month', member),

  gmailStatus: (member: string) => request<GmailStatus>('/api/gmail/status', member),
};

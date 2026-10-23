import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import type { AgentReply } from '@fridge-door/shared';
import { Agent, soundsLikeApproval, type AgentOptions } from '../src/agent/agent.js';
import { Extractor } from '../src/extract/extractor.js';
import { createApp } from '../src/http/app.js';
import { silentLogger } from '../src/lib/logger.js';
import type { OutgoingMail } from '../src/gmail/mail.js';
import { FollowUps } from '../src/service/followups.js';
import { ObligationService } from '../src/service/obligations.js';
import { FakeProvider, FIXTURES, HOUSEHOLD, NOW, ob, raw, ScriptedChat, TZ, tempStore } from './helpers.js';

/**
 * The agent against the real Express app: it connects to /mcp over Streamable
 * HTTP with the official SDK client, so these runs go through the same MCP
 * server Alexa+ would use. Only the model is scripted.
 */
const API_KEY = 'agent-test-key-0123456789';
const { store, cleanup } = await tempStore();
for (const o of FIXTURES) await store.put(o);
await store.put(
  ob({
    id: 'ortho',
    type: 'appointment',
    title: 'Orthodontist visit',
    forWhom: 'Leo',
    dueDate: '2026-10-27T21:00:00.000Z',
    source: 'gmail',
    sourceSnippet: "Leo's braces check is on Tuesday, October 27 at 2:00 PM.",
    email: { gmailMessageId: 'o1', threadId: 'thread-o', messageIdHeader: '<o1@braces.com>', references: null, fromAddress: 'dr.lee@braces.com', fromName: 'Dr. Lee', subject: 'Braces check', demo: false },
  }),
);

const SLIP = 'Field trip slip due 10/11. Bring a packed lunch that day.';
const extractionModel = new FakeProvider(
  [
    raw({ type: 'deadline', title: 'Field trip slip', dueDate: '2026-11-10', sourceSnippet: 'Field trip slip due 10/11.' }),
    raw({ type: 'deadline', title: 'Packed lunch', dueDate: '2026-11-10', sourceSnippet: 'Bring a packed lunch that day.' }),
  ],
  SLIP,
);
const service = new ObligationService(store, { timeZone: TZ, defaultCurrency: 'USD', extractor: new Extractor(extractionModel, TZ), now: () => NOW });

let model = new ScriptedChat([]);
const options: AgentOptions = {
  provider: { name: 'scripted', generateText: async () => '', generateJson: async () => ({}), chat: (req) => model.chat(req) },
  mcpUrl: '', // set once the server is listening
  apiKey: API_KEY,
  timeZone: TZ,
  logger: silentLogger,
  now: () => NOW,
};
const agent = new Agent(options);
const sent: OutgoingMail[] = [];
const followups = new FollowUps({
  service,
  provider: new (class extends FakeProvider {
    override async generateJson() {
      return { body: 'Hi Dr. Lee,\n\nCould we move Leo\'s braces check to Thursday?\n\nThanks,\nPriya', gist: "move Leo's braces check to Thursday" };
    }
  })(),
  gmail: { send: async (mail) => (sent.push(mail), { messageId: 'g1' }) },
  outbox: { send: async () => ({ messageId: 'unused' }) },
  timeZone: TZ,
  logger: silentLogger,
  now: () => NOW,
});
const app = createApp({
  config: { HOST: '127.0.0.1', ALLOWED_HOSTS: undefined, CORS_ORIGINS: 'http://localhost:5173', API_KEY, DEFAULT_HOUSEHOLD_ID: HOUSEHOLD },
  service,
  logger: silentLogger,
  agent,
  followups,
});
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
options.mcpUrl = `${base}/mcp`;

after(async () => {
  server.close();
  await cleanup();
});

async function post(path: string, body: unknown, member = 'Priya'): Promise<AgentReply> {
  const res = await fetch(`${base}/agent${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}`, 'X-Household-Member': member },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as AgentReply;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const call = (name: string, args: Record<string, unknown>, id = `c-${name}`) => ({ id, name, arguments: args });

describe('agent (MCP client)', () => {
  it('lists tools over MCP, runs the call, and answers with a card', async () => {
    model = new ScriptedChat([
      { text: '', toolCalls: [call('whats_due', { range: 'week' })] },
      { text: 'This week you have the water bill tomorrow and three more.', toolCalls: [] },
    ]);
    const r = await post('/chat', { message: "What's due this week?" });

    assert.equal(r.speech, 'This week you have the water bill tomorrow and three more.');
    assert.deepEqual(r.toolCalls, [{ name: 'whats_due', arguments: { range: 'week' }, isError: false }]);
    assert.equal(r.card?.kind, 'due');
    if (r.card?.kind !== 'due') return;
    assert.ok(r.card.result.items.some((o) => o.id === 'card'), "Priya sees her private item through the forwarded header");

    const [first, second] = model.chatRequests;
    assert.deepEqual(first!.tools.map((t) => t.name).sort(), [
      'add_obligation', 'confirm_item', 'discard_draft', 'draft_followup', 'get_source', 'ingest_text', 'mark_done', 'next_up', 'send_followup',
      'start_renewal', 'sync_inbox', 'whats_due', 'who_handled',
    ]);
    assert.ok(!('$schema' in first!.tools[0]!.parameters));
    assert.match(first!.system, /The person speaking is Priya/);
    const toolTurn = second!.messages.at(-1)!;
    assert.equal(toolTurn.role, 'tool');
    if (toolTurn.role === 'tool') assert.match(String((toolTurn.results[0]!.content as { speech: string }).speech), /Water bill/);
  });

  it('keeps the conversation per session and per speaker', async () => {
    model = new ScriptedChat([{ text: 'Hi Priya.', toolCalls: [] }, { text: 'Still here.', toolCalls: [] }, { text: 'Hi Dan.', toolCalls: [] }]);
    const a = await post('/chat', { message: 'Hello' });
    const b = await post('/chat', { message: 'Are you there?', sessionId: a.sessionId });
    assert.equal(b.sessionId, a.sessionId);
    assert.equal(model.chatRequests[1]!.messages.length, 3, 'user, assistant, user');

    const c = await post('/chat', { message: 'Hello', sessionId: a.sessionId }, 'Dan');
    assert.notEqual(c.sessionId, a.sessionId, "Dan doesn't inherit Priya's conversation");
    assert.equal(model.chatRequests[2]!.messages.length, 1);
  });

  it('shows the candidates when mark_done is ambiguous, then marks the one chosen', async () => {
    await service.add({ householdId: HOUSEHOLD, userId: 'Dan' }, { type: 'bill', title: 'Water bill', dueDate: '2026-10-29', sourceSnippet: 'Cabin water bill due the 29th' });
    model = new ScriptedChat([
      { text: '', toolCalls: [call('mark_done', { idOrTitle: 'water bill', doneBy: 'Dan' })] },
      { text: 'Which water bill, the house or the cabin?', toolCalls: [] },
      { text: '', toolCalls: [call('mark_done', { idOrTitle: 'water', doneBy: 'Dan' })] },
      { text: 'Done. I marked the water bill as paid by you.', toolCalls: [] },
    ]);
    const ask = await post('/chat', { message: 'I paid the water bill' }, 'Dan');
    assert.equal(ask.card?.kind, 'choices');
    assert.deepEqual(ask.toolCalls.map((c) => c.isError), [true]);

    const done = await post('/chat', { message: 'The house one', sessionId: ask.sessionId }, 'Dan');
    assert.equal(done.card?.kind, 'item');
    if (done.card?.kind === 'item') {
      assert.equal(done.card.heading, 'Done');
      assert.equal(done.card.item.doneBy, 'Dan');
    }
  });

  it('quotes the source, with the full item found earlier in the conversation', async () => {
    model = new ScriptedChat([
      { text: '', toolCalls: [call('whats_due', { range: 'month' })] },
      { text: '', toolCalls: [call('get_source', { id: 'insurance' })] },
      { text: 'It came from an email.', toolCalls: [] },
    ]);
    const r = await post('/chat', { message: 'Where did the car insurance come from?' });
    assert.equal(r.card?.kind, 'source');
    if (r.card?.kind === 'source') {
      assert.equal(r.card.result.id, 'insurance');
      assert.equal(r.card.item?.amount, 612);
    }
  });

  it('falls back to the tool speech if the model never answers in text', async () => {
    model = new ScriptedChat(Array.from({ length: 5 }, () => ({ text: '', toolCalls: [call('next_up', {})] })));
    const r = await post('/chat', { message: "What's next?" });
    assert.equal(r.toolCalls.length, 5, 'stops after MAX_STEPS');
    assert.match(r.speech, /^Next up/);
  });

  it('ingests a photo and confirms a date through MCP without the model', async () => {
    model = new ScriptedChat([{ text: 'You picked November 10.', toolCalls: [] }]);
    const photo = await post('/action', { tool: 'ingest_image', arguments: { base64: PNG, mimeType: 'image/png' } });
    assert.equal(photo.card?.kind, 'ingest');
    if (photo.card?.kind !== 'ingest') return;
    const pending = photo.card.result.needsConfirmation;
    assert.equal(pending.length, 2, 'the same-day lunch item is flagged too');
    assert.deepEqual(pending[0]!.options, ['2026-10-11', '2026-11-10']);
    assert.deepEqual(photo.toolCalls, [{ name: 'ingest_image', arguments: { mimeType: 'image/png' }, isError: false }]);

    const confirm = await post('/action', { tool: 'confirm_item', arguments: { id: pending[0]!.id, chosenDate: '2026-11-10' }, sessionId: photo.sessionId });
    assert.match(confirm.speech, /^Got it\. Field trip slip/);
    assert.equal(confirm.card?.kind, 'item');

    // The screen actions are in the session, so a spoken follow-up has the ids.
    await post('/chat', { message: 'Thanks', sessionId: photo.sessionId });
    const history = model.chatRequests[0]!.messages.map((m) => (m.role === 'user' ? m.text : '')).join('\n');
    assert.ok(history.includes(pending[1]!.id));
  });

  it('never sends a draft in the turn that wrote it, or without a clear yes', async () => {
    model = new ScriptedChat([
      { text: '', toolCalls: [call('draft_followup', { idOrTitle: 'orthodontist', intent: 'reschedule', details: 'Thursday' })] },
      // The model jumps ahead and tries to send straight away.
      { text: '', toolCalls: [call('send_followup', { draftId: 'PLACEHOLDER', confirmedBy: 'Priya' })] },
      { text: "Here's a draft to Dr. Lee asking to move Leo's braces check to Thursday. Should I send it?", toolCalls: [] },
    ]);
    // Fill in the real draft id once it exists, as a model would.
    const original = model.chat.bind(model);
    model.chat = async (req) => {
      const res = await original(req);
      for (const c of res.toolCalls) {
        if (c.name !== 'send_followup') continue;
        const last = req.messages.at(-1)!;
        const draft = last.role === 'tool' ? (last.results[0]!.content as { draft?: { id: string } }).draft : undefined;
        if (draft) c.arguments.draftId = draft.id;
      }
      return res;
    };
    const drafted = await post('/chat', { message: "Ask the orthodontist to move Leo's appointment to Thursday" });
    assert.deepEqual(drafted.toolCalls.map((c) => [c.name, c.isError]), [['draft_followup', false], ['send_followup', true]]);
    assert.equal(sent.length, 0, 'blocked before it reached the server');
    assert.equal(drafted.card?.kind, 'draft', 'the draft stays on screen');
    if (drafted.card?.kind !== 'draft') return;
    const draft = drafted.card.draft;
    assert.equal(draft.to, 'dr.lee@braces.com');
    assert.equal(draft.subject, 'Re: Braces check');

    model = new ScriptedChat([
      { text: '', toolCalls: [call('send_followup', { draftId: draft.id, confirmedBy: 'Priya' })] },
      { text: 'Should I send it?', toolCalls: [] },
    ]);
    const unsure = await post('/chat', { message: 'Hmm, actually change it to Friday', sessionId: drafted.sessionId });
    assert.deepEqual(unsure.toolCalls.map((c) => c.isError), [true]);
    assert.equal(sent.length, 0);

    model = new ScriptedChat([
      { text: '', toolCalls: [call('send_followup', { draftId: draft.id, confirmedBy: 'Priya' })] },
      { text: "Sent to Dr. Lee. I'll watch for their reply.", toolCalls: [] },
    ]);
    const yes = await post('/chat', { message: 'Yes, send it', sessionId: drafted.sessionId });
    assert.deepEqual(yes.toolCalls.map((c) => [c.name, c.isError]), [['send_followup', false]]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, 'dr.lee@braces.com');
    assert.equal(yes.card?.kind, 'sent');
    if (yes.card?.kind === 'sent') {
      assert.equal(yes.card.delivery, 'gmail');
      assert.equal(yes.card.item.status, 'awaiting_reply');
    }
  });

  it('sends the edited draft from the Send button, and cancels from the Cancel button', async () => {
    const ctx = { householdId: HOUSEHOLD, userId: 'Priya' };
    const a = await followups.draft(ctx, { idOrTitle: 'orthodontist', intent: 'confirm' });
    const edited = await post('/action', { tool: 'send_followup', arguments: { draftId: a.draft!.id, confirmedBy: 'Priya', body: 'Hi! Tuesday is fine.\n\nPriya' } });
    assert.equal(edited.card?.kind, 'sent');
    assert.equal(sent.at(-1)!.body, 'Hi! Tuesday is fine.\n\nPriya', 'exactly the text on screen');
    assert.deepEqual(edited.toolCalls, [{ name: 'send_followup', arguments: { draftId: a.draft!.id, confirmedBy: 'Priya', edited: true }, isError: false }]);

    const b = await followups.draft(ctx, { idOrTitle: 'orthodontist', intent: 'cancel' });
    const cancelled = await post('/action', { tool: 'discard_draft', arguments: { draftId: b.draft!.id } });
    assert.equal(cancelled.speech, "OK, I won't send it.");
    const late = await post('/action', { tool: 'send_followup', arguments: { draftId: b.draft!.id, confirmedBy: 'Priya' } });
    assert.match(late.speech, /cancelled/);

    const dan = await post('/action', { tool: 'send_followup', arguments: { draftId: a.draft!.id, confirmedBy: 'Dan' } }, 'Dan');
    assert.match(dan.speech, /already sent|Only Priya/);
  });

  it('shows a renewal card with the link, and marks it renewed from the button', async () => {
    model = new ScriptedChat([
      { text: '', toolCalls: [call('start_renewal', { idOrTitle: 'orthodontist' })] },
      { text: 'There is no renewal link for that.', toolCalls: [] },
    ]);
    const none = await post('/chat', { message: 'Renew the orthodontist' });
    assert.equal(none.card?.kind, 'item');
    const turn = model.chatRequests[1]!.messages.at(-1)!;
    assert.equal(turn.role, 'tool');

    const done = await post('/action', { tool: 'mark_done', arguments: { idOrTitle: 'insurance', doneBy: 'Priya' } });
    assert.equal(done.card?.kind, 'item');
    if (done.card?.kind === 'item') assert.equal(done.card.item.status, 'done');
  });

  it('drafts for the dentist the person means, and asks with a choice card when it cannot tell', async () => {
    // Saturday's fixture dentist is for Maya (no email); this one came from the dentist's own email.
    await store.put(
      ob({
        id: 'dentist-tue',
        type: 'appointment',
        title: 'Dentist cleaning appointment',
        dueDate: '2026-10-27T22:30:00.000Z',
        source: 'gmail',
        sourceSnippet: 'Your cleaning is booked for Tuesday, October 27 at 3:30 PM.',
        email: { gmailMessageId: 'd2', threadId: 'thread-d2', messageIdHeader: null, references: null, fromAddress: 'frontdesk@smilecare.example', fromName: 'SmileCare Dental', subject: 'Dentist appointment confirmation', demo: false },
      }),
    );
    model = new ScriptedChat([
      { text: '', toolCalls: [call('draft_followup', { idOrTitle: 'dentist appointment', intent: 'reschedule', when: 'Tuesday', details: 'ask if Thursday works' })] },
      { text: "Here's a draft asking to move it. Should I send it?", toolCalls: [] },
    ]);
    const r = await post('/chat', { message: "I can't make the dentist on Tuesday, ask if Thursday works" });
    assert.equal(r.card?.kind, 'draft');
    if (r.card?.kind === 'draft') {
      assert.equal(r.card.item.id, 'dentist-tue');
      assert.equal(r.card.draft.to, 'frontdesk@smilecare.example');
    }

    model = new ScriptedChat([
      { text: '', toolCalls: [call('who_handled', { idOrTitle: 'dentist appointment' })] },
      { text: 'Do you mean the Saturday one for Maya or the Tuesday one from SmileCare Dental?', toolCalls: [] },
    ]);
    const ask = await post('/chat', { message: 'Did anyone handle the dentist appointment?' });
    assert.equal(ask.card?.kind, 'choices');
    if (ask.card?.kind === 'choices') {
      assert.deepEqual(ask.card.candidates.map((c) => [c.id, c.detail]), [['dentist', 'for Maya'], ['dentist-tue', 'from SmileCare Dental']]);
    }
    const toolTurn = model.chatRequests[1]!.messages.at(-1)!;
    assert.equal(toolTurn.role, 'tool');
    if (toolTurn.role === 'tool') assert.equal((toolTurn.results[0]!.content as { error: string }).error, 'Do you mean the Saturday one for Maya or the Tuesday one from SmileCare Dental?');
  });

  it('only counts a clear go-ahead as approval', () => {
    for (const yes of ['Yes', 'send it', 'Yep, go ahead', 'OK send', 'sounds good']) assert.equal(soundsLikeApproval(yes), true, yes);
    for (const no of ["No, don't send it", 'wait', 'Yes but change it to Friday', 'not yet', 'what does it say?', 'cancel it']) {
      assert.equal(soundsLikeApproval(no), false, no);
    }
  });

  it('validates input and allows the simulator origin', async () => {
    const res = await fetch(`${base}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ message: '' }),
    });
    assert.equal(res.status, 400);
    const preflight = await fetch(`${base}/agent/chat`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Headers': 'x-household-member' },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /X-Household-Member/);
    assert.equal((await fetch(`${base}/agent/chat`, { method: 'POST', body: '{}' })).status, 401);
  });
});

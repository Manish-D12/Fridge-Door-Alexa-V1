import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import type { AgentReply } from '@fridge-door/shared';
import { Agent, type AgentOptions } from '../src/agent/agent.js';
import { Extractor } from '../src/extract/extractor.js';
import { createApp } from '../src/http/app.js';
import { silentLogger } from '../src/lib/logger.js';
import { ObligationService } from '../src/service/obligations.js';
import { FakeProvider, FIXTURES, HOUSEHOLD, NOW, raw, ScriptedChat, TZ, tempStore } from './helpers.js';

/**
 * The agent against the real Express app: it connects to /mcp over Streamable
 * HTTP with the official SDK client, so these runs go through the same MCP
 * server Alexa+ would use. Only the model is scripted.
 */
const API_KEY = 'agent-test-key-0123456789';
const { store, cleanup } = await tempStore();
for (const o of FIXTURES) await store.put(o);

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
const app = createApp({
  config: { HOST: '127.0.0.1', ALLOWED_HOSTS: undefined, CORS_ORIGINS: 'http://localhost:5173', API_KEY, DEFAULT_HOUSEHOLD_ID: HOUSEHOLD },
  service,
  logger: silentLogger,
  agent,
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
      'add_obligation', 'confirm_item', 'get_source', 'ingest_text', 'mark_done', 'next_up', 'sync_inbox', 'whats_due', 'who_handled',
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

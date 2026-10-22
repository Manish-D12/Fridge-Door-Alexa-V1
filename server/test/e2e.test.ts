import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/http/app.js';
import { silentLogger } from '../src/lib/logger.js';
import { Extractor } from '../src/extract/extractor.js';
import { ObligationService } from '../src/service/obligations.js';
import { FakeProvider, FIXTURES, HOUSEHOLD, NOW, raw, TZ, tempStore } from './helpers.js';

const API_KEY = 'test-key-0123456789abcdef';
const { store, cleanup } = await tempStore();
for (const o of FIXTURES) await store.put(o);

const DENTIST_TEXT = 'Bright Smiles: Leo is booked for a cleaning on 11/12 at 3:00 PM.';
const provider = new FakeProvider(
  [raw({ type: 'appointment', title: 'Leo dentist', forWhom: 'Leo', dueDate: '2026-11-12', dueTime: '15:00', sourceSnippet: DENTIST_TEXT })],
  DENTIST_TEXT,
);
const service = new ObligationService(store, { timeZone: TZ, defaultCurrency: 'USD', extractor: new Extractor(provider, TZ), now: () => NOW });
const app = createApp({
  config: { HOST: '127.0.0.1', ALLOWED_HOSTS: undefined, CORS_ORIGINS: undefined, API_KEY, DEFAULT_HOUSEHOLD_ID: HOUSEHOLD },
  service,
  logger: silentLogger,
});
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function connect(userId?: string): Promise<Client> {
  const headers: Record<string, string> = { Authorization: `Bearer ${API_KEY}` };
  if (userId) headers['X-User-Id'] = userId;
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  return client;
}

const structured = <T>(r: unknown) => (r as CallToolResult).structuredContent as T;

let client: Client;
before(async () => {
  client = await connect('Priya');
});
after(async () => {
  await client?.close();
  server.close();
  await cleanup();
});

describe('MCP over Streamable HTTP', () => {
  it('negotiates the latest protocol version and lists all 9 tools with output schemas', async () => {
    assert.equal(LATEST_PROTOCOL_VERSION, '2025-11-25');
    assert.equal(client.getServerVersion()?.name, 'fridge-door');
    assert.ok(client.getInstructions()?.includes('speech'));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'add_obligation', 'confirm_item', 'get_source', 'ingest_image', 'ingest_text', 'mark_done', 'next_up', 'whats_due', 'who_handled',
    ]);
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 40, `${t.name} needs a description`);
      assert.ok(t.outputSchema, `${t.name} needs an output schema`);
    }
  });

  it('runs every tool', async () => {
    const due = await client.callTool({ name: 'whats_due', arguments: { range: 'week' } });
    assert.ok(!due.isError);
    assert.ok(structured<{ items: { id: string }[] }>(due).items.some((o) => o.id === 'card'), 'owner sees private item');

    const next = await client.callTool({ name: 'next_up', arguments: { type: 'order' } });
    assert.equal(structured<{ item: { id: string } }>(next).item.id, 'delivery');

    const added = await client.callTool({
      name: 'add_obligation',
      arguments: { type: 'booking', title: 'Pumpkin patch tickets', dueDate: '2026-10-25T11:00:00-07:00', sourceSnippet: 'book the pumpkin patch sunday at 11' },
    });
    const addedId = structured<{ item: { id: string } }>(added).item.id;
    assert.match((added.content as { text: string }[])[0]!.text, /^Added Pumpkin patch tickets, on Sunday at 11:00 AM\.$/);

    const done = await client.callTool({ name: 'mark_done', arguments: { idOrTitle: 'pumpkin patch', doneBy: 'Dan' } });
    assert.equal(structured<{ item: { status: string } }>(done).item.status, 'done');

    const who = await client.callTool({ name: 'who_handled', arguments: { idOrTitle: addedId } });
    assert.equal(structured<{ doneBy: string }>(who).doneBy, 'Dan');

    const source = await client.callTool({ name: 'get_source', arguments: { id: addedId } });
    assert.equal(structured<{ sourceSnippet: string }>(source).sourceSnippet, 'book the pumpkin patch sunday at 11');

    const text = await client.callTool({ name: 'ingest_text', arguments: { text: DENTIST_TEXT, source: 'whatsapp' } });
    const ingested = structured<{ items: { id: string }[]; needsConfirmation: { id: string; question: string }[] }>(text);
    assert.equal(ingested.items.length, 1);
    assert.equal(ingested.needsConfirmation[0]!.question, 'Is Leo dentist on Thursday, November 12, or Friday, December 11?');

    const confirmed = await client.callTool({ name: 'confirm_item', arguments: { id: ingested.items[0]!.id, chosenDate: '2026-11-12' } });
    assert.equal(structured<{ item: { needsConfirmation: boolean } }>(confirmed).item.needsConfirmation, false);

    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    const image = await client.callTool({ name: 'ingest_image', arguments: { base64: png, mimeType: 'image/png' } });
    assert.match((image.content as { text: string }[])[0]!.text, /already on the list/);
  });

  it('returns tool errors (not protocol errors) for unknown or ambiguous items', async () => {
    const r = await client.callTool({ name: 'who_handled', arguments: { idOrTitle: 'gym membership' } });
    assert.equal(r.isError, true);
    assert.match((r.content as { text: string }[])[0]!.text, /couldn't find anything matching "gym membership"/);
  });

  it('rejects invalid arguments', async () => {
    const r = await client.callTool({ name: 'whats_due', arguments: { range: 'fortnight' } });
    assert.equal(r.isError, true);
  });

  it('hides private items from other members', async () => {
    const dan = await connect('Dan');
    try {
      const r = await dan.callTool({ name: 'get_source', arguments: { id: 'card' } });
      assert.equal(r.isError, true);
    } finally {
      await dan.close();
    }
  });

  it('requires the bearer token when API_KEY is set', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects GET /mcp in stateless mode', async () => {
    const res = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'text/event-stream' } });
    assert.equal(res.status, 405);
  });
});

describe('REST API', () => {
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}/api${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'X-User-Id': 'Dan', ...init.headers },
    });

  it('mirrors the MCP operations', async () => {
    let res = await api('/obligations/due?range=today');
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { items: { id: string }[] }).items.map((o) => o.id), ['today-appt', 'delivery']);

    res = await api('/obligations/next?type=appointment');
    assert.equal(((await res.json()) as { item: { id: string } }).item.id, 'today-appt');

    res = await api('/obligations', {
      method: 'POST',
      body: JSON.stringify({ type: 'deadline', title: 'Passport renewal form', dueDate: '2026-11-03', sourceSnippet: 'mail the passport form by nov 3' }),
    });
    assert.equal(res.status, 201);
    const { item } = (await res.json()) as { item: { id: string } };

    res = await api('/obligations/mark-done', { method: 'POST', body: JSON.stringify({ idOrTitle: 'passport', doneBy: 'Dan' }) });
    assert.equal(res.status, 200);

    res = await api(`/obligations/who-handled?idOrTitle=${encodeURIComponent(item.id)}`);
    assert.equal(((await res.json()) as { doneBy: string }).doneBy, 'Dan');

    res = await api(`/obligations/${item.id}/source`);
    assert.equal(((await res.json()) as { source: string }).source, 'manual');

    res = await api('/ingest/text', { method: 'POST', body: JSON.stringify({ text: 'hello', source: 'gmail' }) });
    assert.equal(res.status, 200);
    assert.ok(((await res.json()) as { skipped: { reason: string }[] }).skipped.some((x) => x.reason === 'snippet_not_found'));

    res = await api('/obligations/confirm', { method: 'POST', body: JSON.stringify({ id: item.id, chosenDate: '2026-12-01' }) });
    assert.equal(res.status, 200);

    res = await api('/obligations');
    const all = ((await res.json()) as { items: { id: string }[] }).items.map((o) => o.id);
    assert.ok(!all.includes('card'), 'Dan must not see Priya\'s private item');
  });

  it('returns structured errors', async () => {
    let res = await api('/obligations/due?range=fortnight');
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'bad_request');

    res = await api('/obligations/card/source');
    assert.equal(res.status, 404);

    res = await api('/obligations', { method: 'POST', body: '{not json' });
    assert.equal(res.status, 400);
  });
});

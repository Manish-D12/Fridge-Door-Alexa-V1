import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { AppError } from '../src/lib/errors.js';
import { ObligationService, type RequestContext } from '../src/service/obligations.js';
import type { LocalJsonStore } from '../src/store/local.js';
import { FIXTURES, HOUSEHOLD, NOW, TZ, tempStore } from './helpers.js';

const priya: RequestContext = { householdId: HOUSEHOLD, userId: 'priya' };
const dan: RequestContext = { householdId: HOUSEHOLD, userId: 'Dan' };
const anon: RequestContext = { householdId: HOUSEHOLD, userId: null };

const { store, cleanup } = await tempStore();
after(cleanup);

let service: ObligationService;
let nextId = 0;

beforeEach(async () => {
  await (store as LocalJsonStore).clearHousehold(HOUSEHOLD);
  for (const o of FIXTURES) await store.put(o);
  service = new ObligationService(store, { timeZone: TZ, defaultCurrency: 'USD', now: () => NOW, newId: () => `new-${++nextId}` });
});

const ids = (items: { id: string }[]) => items.map((o) => o.id);

async function rejectsWith(p: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected ${code} error`);
}

describe('whats_due', () => {
  it('today: includes items later today, flags overdue separately', async () => {
    const r = await service.whatsDue(anon, { range: 'today' });
    assert.deepEqual(ids(r.items), ['today-appt', 'delivery']);
    assert.deepEqual(ids(r.overdue), ['overdue']);
    assert.equal(
      r.speech,
      '2 things are due today: Vet checkup, today at 4:00 PM; and Amazon delivery: rain boots, arriving today at 8:00 PM. Also overdue: Library books, due 3 days ago.',
    );
    assert.equal(r.window.start, '2026-10-21T07:00:00.000Z');
    assert.equal(r.window.end, '2026-10-22T06:59:59.999Z');
  });

  it('tomorrow', async () => {
    const r = await service.whatsDue(anon, { range: 'tomorrow' });
    assert.deepEqual(ids(r.items), ['water']);
    assert.match(r.speech, /^One thing is due tomorrow: Water bill, \$84\.20, due tomorrow\./);
  });

  it('week excludes done items and hides private items from others', async () => {
    assert.deepEqual(ids((await service.whatsDue(anon, { range: 'week' })).items), ['today-appt', 'delivery', 'water', 'dentist']);
    assert.deepEqual(ids((await service.whatsDue(dan, { range: 'week' })).items), ['today-appt', 'delivery', 'water', 'dentist']);
    // Private card bill is visible to its owner (case-insensitive match).
    assert.deepEqual(ids((await service.whatsDue(priya, { range: 'week' })).items), ['today-appt', 'delivery', 'water', 'dentist', 'card']);
  });

  it('month reaches 30 days out and caps what is spoken', async () => {
    const r = await service.whatsDue(anon, { range: 'month' });
    assert.ok(ids(r.items).includes('insurance'));
    assert.match(r.speech, /^5 things are due in the next 30 days: Vet checkup, today at 4:00 PM; .*; and 2 more\. Also overdue/);
  });

  it('filters by forWhom', async () => {
    const r = await service.whatsDue(anon, { range: 'week', forWhom: 'maya' });
    assert.deepEqual(ids(r.items), ['dentist']);
    assert.deepEqual(ids(r.overdue), []);
    assert.equal(r.speech, 'One thing is due for maya in the next 7 days: Dentist appointment, for Maya, on Saturday at 3:30 PM.');
  });

  it('says so when nothing is due', async () => {
    const r = await service.whatsDue(anon, { range: 'tomorrow', forWhom: 'Leo' });
    assert.equal(r.speech, 'Nothing is due for Leo tomorrow.');
  });
});

describe('next_up', () => {
  it('defaults to appointments, bookings and deliveries', async () => {
    const r = await service.nextUp(anon, {});
    assert.equal(r.item?.id, 'today-appt');
    assert.equal(r.speech, 'Next up: Vet checkup, today at 4:00 PM.');
  });

  it('narrows by type', async () => {
    const r = await service.nextUp(anon, { type: 'order' });
    assert.equal(r.item?.id, 'delivery');
    assert.equal(r.speech, 'The next delivery is Amazon delivery: rain boots, arriving today at 8:00 PM.');
  });

  it('handles nothing upcoming', async () => {
    const r = await service.nextUp(anon, { type: 'booking' });
    assert.equal(r.item, null);
    assert.equal(r.speech, 'There are no upcoming bookings.');
  });
});

describe('add_obligation', () => {
  it('applies defaults and treats a plain date as end of that local day', async () => {
    const r = await service.add(dan, {
      type: 'bill',
      title: 'Electric bill',
      dueDate: '2026-10-30',
      amount: 120.5,
      currency: 'usd',
      sourceSnippet: 'add the electric bill, 120.50, due the 30th',
    });
    assert.equal(r.item.dueDate, '2026-10-31T06:59:59.999Z');
    assert.equal(r.item.currency, 'USD');
    assert.equal(r.item.addedBy, 'Dan');
    assert.equal(r.item.source, 'manual');
    assert.equal(r.item.confidence, 1);
    assert.equal(r.item.status, 'pending');
    assert.equal(r.speech, 'Added Electric bill, $120.50, due on October 30.');
    assert.deepEqual(await store.get(HOUSEHOLD, r.item.id), r.item);
  });

  it('normalises offsets to UTC', async () => {
    const r = await service.add(anon, { type: 'appointment', title: 'Haircut', dueDate: '2026-10-23T09:00:00-07:00', sourceSnippet: 'haircut friday 9am' });
    assert.equal(r.item.dueDate, '2026-10-23T16:00:00.000Z');
    assert.equal(r.item.addedBy, 'household');
  });

  it('requires an identity for private items', async () => {
    await rejectsWith(service.add(anon, { type: 'bill', title: 'Gift', dueDate: '2026-10-30', sourceSnippet: 'secret', private: true }), 'bad_request');
    const r = await service.add(priya, { type: 'bill', title: 'Gift', dueDate: '2026-10-30', sourceSnippet: 'secret', private: true });
    assert.match(r.speech, /Only priya can see it\.$/);
  });
});

describe('mark_done', () => {
  it('matches by spoken title and prefers the pending item', async () => {
    const r = await service.markDone(dan, { idOrTitle: 'the water bill', doneBy: 'Dan' });
    assert.equal(r.item.id, 'water');
    assert.equal(r.item.status, 'done');
    assert.equal(r.item.doneBy, 'Dan');
    assert.equal(r.alreadyDone, false);
    assert.equal(r.speech, 'Done. Water bill is marked as handled by Dan.');
  });

  it('matches on forWhom and type words', async () => {
    const r = await service.markDone(anon, { idOrTitle: "Maya's dentist", doneBy: 'Priya' });
    assert.equal(r.item.id, 'dentist');
  });

  it('reports items that were already done', async () => {
    const r = await service.markDone(anon, { idOrTitle: 'rent', doneBy: 'Priya' });
    assert.equal(r.alreadyDone, true);
    assert.equal(r.item.doneBy, 'Dan');
    assert.match(r.speech, /^Rent was already handled by Dan/);
  });

  it('cannot touch private items of others', async () => {
    await rejectsWith(service.markDone(dan, { idOrTitle: 'credit card', doneBy: 'Dan' }), 'not_found');
    await rejectsWith(service.markDone(dan, { idOrTitle: 'card', doneBy: 'Dan' }), 'not_found');
  });

  it('asks when the match is ambiguous', async () => {
    await service.add(anon, { type: 'bill', title: 'Water bill', dueDate: '2026-10-28', sourceSnippet: 'second water bill' });
    const err = await rejectsWith(service.markDone(anon, { idOrTitle: 'water bill', doneBy: 'Dan' }), 'ambiguous');
    assert.equal(err.extra.candidates?.length, 2);
    assert.match(err.message, /Which one did you mean\?$/);
  });
});

describe('who_handled', () => {
  it('reports who and when', async () => {
    const r = await service.whoHandled(anon, { idOrTitle: 'rent' });
    assert.equal(r.handled, true);
    assert.equal(r.doneBy, 'Dan');
    assert.equal(r.speech, 'Dan handled Rent yesterday at 7:12 PM.');
  });

  it('prefers done items when titles repeat', async () => {
    const r = await service.whoHandled(anon, { idOrTitle: 'water bill' });
    assert.equal(r.item.id, 'water-old');
    assert.equal(r.doneBy, 'Priya');
  });

  it('reports pending items as unhandled', async () => {
    const r = await service.whoHandled(anon, { idOrTitle: 'insurance' });
    assert.equal(r.handled, false);
    assert.equal(r.speech, "Nobody has handled Car insurance renewal yet. It's due on November 14.");
  });

  it('returns not_found for unknown items', async () => {
    await rejectsWith(service.whoHandled(anon, { idOrTitle: 'gym membership' }), 'not_found');
  });
});

describe('get_source', () => {
  it('quotes the snippet', async () => {
    const r = await service.getSource(anon, { id: 'water' });
    assert.equal(r.sourceSnippet, 'snippet for Water bill');
    assert.equal(r.speech, 'Water bill was added by Priya, who said: "snippet for Water bill"');
  });

  it('hides private items from others but not their owner', async () => {
    await rejectsWith(service.getSource(dan, { id: 'card' }), 'not_found');
    assert.equal((await service.getSource(priya, { id: 'card' })).id, 'card');
  });
});

describe('ingest stubs', () => {
  it('ingest_text returns pending_bedrock', async () => {
    const r = await service.ingestText(anon, { text: 'Your bill of $40 is due Friday', source: 'gmail' });
    assert.equal(r.status, 'pending_bedrock');
    assert.equal(r.receivedBytes, 30);
    assert.deepEqual(r.extracted, []);
  });

  it('ingest_image checks the image signature', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    const r = await service.ingestImage(anon, { base64: png, mimeType: 'image/png' });
    assert.equal(r.status, 'pending_bedrock');
    assert.equal(r.receivedBytes, 16);
    await rejectsWith(service.ingestImage(anon, { base64: png, mimeType: 'image/jpeg' }), 'bad_request');
  });
});

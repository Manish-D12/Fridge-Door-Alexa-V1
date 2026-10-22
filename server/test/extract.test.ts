import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { cacheKey, FileExtractionCache, MemoryExtractionCache } from '../src/extract/cache.js';
import { ambiguousAlternative, Extractor, locateSnippet } from '../src/extract/extractor.js';
import { GeminiProvider, isQuotaError, withModelFallback } from '../src/llm/gemini.js';
import { FakeProvider, NOW, raw, TZ } from './helpers.js';

describe('locateSnippet', () => {
  const doc = 'Hi all,\nThe “Fall Fest” is on Oct 30 –\nplease RSVP.\n';

  it('returns exact matches as-is', () => {
    assert.equal(locateSnippet(doc, 'please RSVP.'), 'please RSVP.');
  });

  it("tolerates re-flowed whitespace and quote/dash style, returning the document's text", () => {
    assert.equal(locateSnippet(doc, 'The "Fall Fest" is on Oct 30 - please RSVP.'), 'The “Fall Fest” is on Oct 30 –\nplease RSVP.');
  });

  it('rejects anything else', () => {
    assert.equal(locateSnippet(doc, 'The Fall Fest is on Oct 31.'), null);
    assert.equal(locateSnippet(doc, 'fall fest'), null);
    assert.equal(locateSnippet(doc, '   '), null);
    assert.equal(locateSnippet('a.c', 'a.b'), null, 'regex characters are literal');
  });
});

describe('ambiguousAlternative', () => {
  it('returns the other reading of a day/month pair', () => {
    assert.equal(ambiguousAlternative('Bake sale 10/11', '2026-10-11'), '2026-11-10');
    assert.equal(ambiguousAlternative('Bake sale 10/11', '2026-11-10'), '2026-10-11');
    assert.equal(ambiguousAlternative('due 03/04/27', '2027-03-04'), '2027-04-03');
  });

  it('ignores pairs that only read one way, or that are not the due date', () => {
    assert.equal(ambiguousAlternative('due 10/25', '2026-10-25'), null);
    assert.equal(ambiguousAlternative('due 11/11', '2026-11-11'), null);
    assert.equal(ambiguousAlternative('Use 1/2 cup. Due Oct 30', '2026-10-30'), null);
    assert.equal(ambiguousAlternative('Policy 2026/10/11', '2026-10-11'), null);
  });

  it('trusts a weekday that fits only one reading', () => {
    assert.equal(ambiguousAlternative('Sun 10/11', '2026-10-11'), null); // Oct 11 2026 is a Sunday
    assert.equal(ambiguousAlternative('Tuesday 10/11', '2026-11-10'), null); // Nov 10 is a Tuesday
    assert.equal(ambiguousAlternative('Friday 10/11', '2026-10-11'), '2026-11-10'); // neither fits
  });
});

describe('extraction cache', () => {
  const doc = 'Water bill: $40.00 due Oct 30, 2026.';
  const item = raw({ title: 'Water bill', dueDate: '2026-10-30', amount: 40, sourceSnippet: 'Water bill: $40.00 due Oct 30, 2026.' });
  const opts = { sourceDescription: 'an email', now: NOW };

  it('sends the same document to the model only once, and still checks the cached answer', async () => {
    const provider = new FakeProvider([item, raw({ title: 'Made up', sourceSnippet: 'not in the document' })]);
    const extractor = new Extractor(provider, TZ, new MemoryExtractionCache());

    const first = await extractor.extract(doc, opts);
    const second = await extractor.extract(doc, opts);
    assert.equal(provider.jsonRequests.length, 1);
    assert.deepEqual([first.cached, second.cached], [false, true]);
    assert.deepEqual(second.items, first.items);
    assert.deepEqual(second.rejected, [{ title: 'Made up', reason: 'snippet_not_found' }]);

    await extractor.extract(`${doc} `, opts);
    assert.equal(provider.jsonRequests.length, 2, 'different content is a different key');
  });

  it('caches photo transcripts by image bytes', async () => {
    const provider = new FakeProvider([], '  Slip due Friday  ');
    const extractor = new Extractor(provider, TZ, new MemoryExtractionCache());
    const image = { bytes: Buffer.from('fake image'), mimeType: 'image/png' as const };
    assert.equal(await extractor.transcribe(image), 'Slip due Friday');
    assert.equal(await extractor.transcribe({ ...image, bytes: Buffer.from('fake image') }), 'Slip due Friday');
    assert.equal(provider.textRequests.length, 1);
  });

  it('persists answers to disk and treats an unreadable cache as a miss', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fridge-door-cache-'));
    try {
      const provider = new FakeProvider([item]);
      await new Extractor(provider, TZ, new FileExtractionCache(dir)).extract(doc, opts);
      const again = await new Extractor(provider, TZ, new FileExtractionCache(dir)).extract(doc, opts);
      assert.equal(provider.jsonRequests.length, 1);
      assert.equal(again.cached, true);
      assert.equal((await readdir(dir)).length, 1);

      const blocked = new FileExtractionCache(path.join(dir, 'missing', '\0bad'));
      assert.equal(await blocked.get('k'), undefined);
      await blocked.set('k', 1); // does not throw
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prefers the code-derived reading of a numeric date over the model's alternative", async () => {
    const provider = new FakeProvider([
      raw({ type: 'booking', title: 'Bake sale', dueDate: '2026-11-12', needsConfirmation: true, alternativeDueDate: '2026-11-02', sourceSnippet: 'bake sale is on 11/12' }),
    ]);
    const { items } = await new Extractor(provider, TZ).extract('Our bake sale is on 11/12 in the courtyard.', opts);
    assert.equal(items[0]!.confirmationQuestion, 'Is Bake sale on Thursday, November 12, or Friday, December 11?');
  });

  it('keys are length-prefixed', () => {
    assert.notEqual(cacheKey('ab', 'c'), cacheKey('a', 'bc'));
    assert.equal(cacheKey('a', Buffer.from('b')), cacheKey('a', 'b'));
  });
});

describe('withModelFallback', () => {
  const quota = Object.assign(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"61200s"}]}}'), { status: 429 });

  it('tries the next model once on a quota error', async () => {
    const tried: string[] = [];
    const fallbacks: unknown[] = [];
    const out = await withModelFallback(
      ['a', 'b', 'c'],
      async (m) => {
        tried.push(m);
        if (m === 'a') throw quota;
        return `answer from ${m}`;
      },
      (info) => fallbacks.push(info),
    );
    assert.equal(out, 'answer from b');
    assert.deepEqual(tried, ['a', 'b']);
    assert.deepEqual(fallbacks, [{ from: 'a', to: 'b', reason: 'quota exceeded; retry in 61200s' }]);
  });

  it('throws other errors at once, and the last quota error when every model is out', async () => {
    const tried: string[] = [];
    await assert.rejects(withModelFallback(['a', 'b'], async (m) => { tried.push(m); throw new Error('400 bad request'); }), /400/);
    assert.deepEqual(tried, ['a']);
    await assert.rejects(withModelFallback(['a', 'b'], async () => { throw quota; }), /RESOURCE_EXHAUSTED/);
  });

  it('recognises quota errors by status or message', () => {
    assert.equal(isQuotaError(quota), true);
    assert.equal(isQuotaError(new Error('got status: 429 Too Many Requests')), true);
    assert.equal(isQuotaError(Object.assign(new Error('nope'), { status: 503 })), false);
  });

  it('puts the primary model first without repeating it', () => {
    assert.deepEqual(new GeminiProvider('key', 'gemini-2.5-flash-lite', ['gemini-2.5-flash-lite', 'gemini-2.0-flash']).models, ['gemini-2.5-flash-lite', 'gemini-2.0-flash']);
    assert.deepEqual(new GeminiProvider('key', 'gemini-2.5-flash', ['gemini-2.5-flash-lite']).models, ['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  });
});

describe('config', () => {
  it('defaults to flash-lite with a fallback list', () => {
    const c = loadConfig({});
    assert.equal(c.GEMINI_MODEL, 'gemini-2.5-flash-lite');
    assert.deepEqual(c.GEMINI_FALLBACK_MODELS, ['gemini-2.5-flash-lite', 'gemini-2.0-flash']);
    assert.deepEqual(loadConfig({ GEMINI_FALLBACK_MODELS: ' x, ,y ' }).GEMINI_FALLBACK_MODELS, ['x', 'y']);
  });
});

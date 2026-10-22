import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ambiguousAlternative, locateSnippet } from '../src/extract/extractor.js';

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

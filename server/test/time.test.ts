import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { endOfLocalDay, localDateOf, spokenWhen, startOfLocalDay, zonedTimeToInstant } from '../src/lib/time.js';

const LA = 'America/Los_Angeles';

describe('time helpers', () => {
  it('finds local midnight in the household time zone', () => {
    assert.equal(new Date(startOfLocalDay({ year: 2026, month: 10, day: 21 }, LA)).toISOString(), '2026-10-21T07:00:00.000Z');
    assert.equal(new Date(endOfLocalDay({ year: 2026, month: 10, day: 21 }, LA)).toISOString(), '2026-10-22T06:59:59.999Z');
  });

  it('handles the DST fall-back day (25 hours long)', () => {
    const start = startOfLocalDay({ year: 2026, month: 11, day: 1 }, LA);
    const end = endOfLocalDay({ year: 2026, month: 11, day: 1 }, LA);
    assert.equal(new Date(start).toISOString(), '2026-11-01T07:00:00.000Z');
    assert.equal(end + 1 - start, 25 * 3600 * 1000);
  });

  it('converts wall-clock times across DST', () => {
    assert.equal(new Date(zonedTimeToInstant({ year: 2026, month: 3, day: 9 }, LA, 9)).toISOString(), '2026-03-09T16:00:00.000Z');
    assert.equal(new Date(zonedTimeToInstant({ year: 2026, month: 3, day: 7 }, LA, 9)).toISOString(), '2026-03-07T17:00:00.000Z');
  });

  it('uses the local date, not the UTC date', () => {
    // 11 PM PDT on Oct 21 is already Oct 22 in UTC.
    assert.deepEqual(localDateOf(Date.parse('2026-10-22T06:00:00Z'), LA), { year: 2026, month: 10, day: 21 });
  });

  it('phrases due dates for speech', () => {
    const now = Date.parse('2026-10-21T17:00:00Z'); // Wed 10 AM PDT
    assert.equal(spokenWhen('2026-10-21T23:00:00.000Z', now, LA), 'today at 4:00 PM');
    assert.equal(spokenWhen('2026-10-23T06:59:59.999Z', now, LA), 'tomorrow');
    assert.equal(spokenWhen('2026-10-24T22:30:00.000Z', now, LA), 'on Saturday at 3:30 PM');
    assert.equal(spokenWhen('2026-11-15T07:59:59.999Z', now, LA), 'on November 14');
    assert.equal(spokenWhen('2026-10-19T06:59:59.999Z', now, LA), '3 days ago');
  });
});

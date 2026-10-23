import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { proposedInstant, proposedTime, readReply, replyEffect, stripQuoted } from '../src/service/replies.js';
import { NOW, TZ } from './helpers.js';

// The real thread, as Gmail's plain-text parts gave it.
const OUR_EMAIL =
  'Hello,I would like to reschedule my dentist cleaning appointment for Wednesday, October 28th at 3:30 PM. ' +
  'Would it be possible to move it to Thursday, October 29th at 4 PM instead?Thank you,Priya';
const THEIR_REPLY =
  'Yes, we can do that. Please be on time as im would be running late for\nanother appointment\n\n' +
  'On Sat, 24 Oct 2026 at 02:04, Priya Shah <priya@example.com>\nwrote:\n\n' +
  '> Hello,I would like to reschedule my dentist cleaning appointment for\n> Wednesday, October 28th at 3:30 PM. Would it be possible to move it to\n> Thursday, October 29th at 4 PM instead?';
const WED_330 = Date.parse('2026-10-28T22:30:00.000Z'); // Wed Oct 28, 3:30 PM in Los Angeles

describe('reading replies to follow-ups', () => {
  it('keeps only the new text', () => {
    assert.equal(stripQuoted(THEIR_REPLY), 'Yes, we can do that. Please be on time as im would be running late for\nanother appointment');
    assert.equal(stripQuoted('Sure.\n-----Original Message-----\nFrom: x'), 'Sure.');
    assert.equal(stripQuoted('See you then.\n> quoted'), 'See you then.');
  });

  it('reads a yes, and keeps the rest as a note', () => {
    assert.deepEqual(readReply(THEIR_REPLY), {
      outcome: 'accepted',
      gist: 'Yes, we can do that.',
      note: 'Please be on time as im would be running late for another appointment',
    });
    assert.deepEqual(readReply('No problem, see you then!\n\nThanks,\nDr. Lee'), { outcome: 'accepted', gist: 'No problem, see you then!', note: null });
  });

  it('reads a no, and anything else as neither', () => {
    assert.equal(readReply("Sorry, we're fully booked on Thursday. How about Friday at 10?").outcome, 'declined');
    assert.equal(readReply("Unfortunately that won't work.").outcome, 'declined');
    assert.equal(readReply('Which time would suit you best?').outcome, 'other');
    assert.equal(readReply('Yes but not Thursday.').outcome, 'declined', 'a yes taken back is not a yes');
  });

  it('finds the new time we proposed, ignoring the current one', () => {
    const p = proposedTime(OUR_EMAIL, WED_330, NOW, TZ);
    assert.deepEqual(p, { date: { year: 2026, month: 10, day: 29 }, hour: 16, minute: 0 });
    assert.equal(new Date(proposedInstant(p!, WED_330, TZ)).toISOString(), '2026-10-29T23:00:00.000Z', 'Thu Oct 29, 4:00 PM in Los Angeles');
  });

  it('keeps the time of day when only a date was proposed, and gives up when it is unclear', () => {
    const dateOnly = proposedTime('Could we do November 2 instead?', WED_330, NOW, TZ)!;
    assert.equal(new Date(proposedInstant(dateOnly, WED_330, TZ)).toISOString(), '2026-11-02T23:30:00.000Z', '3:30 PM, now standard time');
    assert.deepEqual(proposedTime('Could we do Thursday at 9:15 am?', WED_330, NOW, TZ), { date: { year: 2026, month: 10, day: 22 }, hour: 9, minute: 15 });
    assert.equal(proposedTime('Could we do October 29 or October 30?', WED_330, NOW, TZ), null, 'two options: ask, do not guess');
    assert.equal(proposedTime('Could we move it to a later time?', WED_330, NOW, TZ), null);
    assert.deepEqual(proposedTime('Can we do January 5 at noon?', WED_330, NOW, TZ)!.date, { year: 2027, month: 1, day: 5 });
  });

  it('only changes the item when the reply says yes to something concrete', () => {
    const yes = readReply(THEIR_REPLY);
    assert.equal(replyEffect('reschedule', yes, 1), 'move');
    assert.equal(replyEffect('reschedule', yes, null), 'none');
    assert.equal(replyEffect('cancel', yes, null), 'cancel');
    assert.equal(replyEffect('confirm', yes, null), 'none');
    assert.equal(replyEffect('reschedule', readReply('Sorry, no.'), 1), 'none');
  });
});

/**
 * Seeds a demo household with 10 realistic obligations.
 *   npm run seed                 # resets DEFAULT_HOUSEHOLD_ID, then inserts
 *   npm run seed -- --no-reset   # upserts without clearing first
 *
 * Dates are relative to "now" in HOUSEHOLD_TIMEZONE so the demo always has
 * something due today/tomorrow/this week, and each sourceSnippet quotes the
 * same dates as its dueDate.
 *
 * A reset also forgets which emails Gmail sync has read (the connection stays),
 * so "check my email" finds them again. Their extraction is cached, so that
 * costs no model calls.
 *
 * The dentist appointment and the car insurance renewal carry a Gmail-style
 * source (sender, thread, and for the insurance a renewal link) so follow-up
 * actions can be demoed. They are marked demo: those emails were never in
 * anyone's inbox, so replies go to the local demo outbox, not Gmail.
 */
import { ObligationSchema, type Obligation } from '@fridge-door/shared';
import { loadConfig } from '../src/config.js';
import { GmailState } from '../src/gmail/state.js';
import { addLocalDays, endOfLocalDay, localDateOf, zonedTimeToInstant } from '../src/lib/time.js';
import { createStore } from '../src/store/index.js';

const config = loadConfig();
const store = createStore(config);
const householdId = config.DEFAULT_HOUSEHOLD_ID;
const tz = config.HOUSEHOLD_TIMEZONE;
const reset = !process.argv.includes('--no-reset');

const now = Date.now();
const today = localDateOf(now, tz);

/** Instant at a wall-clock time `days` from today. */
const at = (days: number, hour: number, minute = 0) => zonedTimeToInstant(addLocalDays(today, days), tz, hour, minute);
/** End of the local day `days` from today ("due by"). */
const by = (days: number) => endOfLocalDay(addLocalDays(today, days), tz);
const iso = (ms: number) => new Date(ms).toISOString();

const fmt = (ms: number, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(ms);
const longDate = (ms: number) => fmt(ms, { weekday: 'long', month: 'long', day: 'numeric' });
const shortDate = (ms: number) => fmt(ms, { month: 'short', day: 'numeric', year: 'numeric' });
const numericDate = (ms: number) => fmt(ms, { month: '2-digit', day: '2-digit', year: 'numeric' });
const time = (ms: number) => fmt(ms, { hour: 'numeric', minute: '2-digit' });

type Seed = Omit<
  Obligation,
  | 'householdId' | 'currency' | 'status' | 'doneBy' | 'doneAt' | 'createdAt' | 'private'
  | 'needsConfirmation' | 'confirmationQuestion' | 'confirmationOptions' | 'email' | 'links' | 'actions'
> &
  Partial<Pick<Obligation, 'status' | 'doneBy' | 'doneAt' | 'private' | 'email' | 'links'>> & { createdDaysAgo: number };

/** A sample email: replies to it are saved to the demo outbox. */
const demoEmail = (id: string, fromName: string, fromAddress: string, subject: string): Obligation['email'] => ({
  gmailMessageId: `demo-${id}`,
  threadId: `demo-${id}`,
  messageIdHeader: `<${id}@${fromAddress.split('@')[1]}>`,
  references: null,
  fromAddress,
  fromName,
  subject,
  demo: true,
});

const fieldTripDue = by(2);
const fieldTripDate = by(14);
const waterDue = by(1);
const insuranceDue = by(12);
// Delivered today by 8 PM, unless that has already passed when seeding.
const deliveryAt = Number(fmt(now, { hour: 'numeric', hourCycle: 'h23' })) < 19 ? at(0, 20) : at(1, 20);
const dentistAt = at(3, 15, 30);
const movieAt = at(4, 18, 45);
const conferenceAt = at(6, 16, 15);
const cardDue = by(8);
const warrantyEnds = by(25);
const rentDue = by(3);
const rentPaid = at(-1, 19, 12);

const seeds: Seed[] = [
  {
    id: 'seed-field-trip-slip',
    type: 'deadline',
    title: 'Field trip permission slip',
    dueDate: iso(fieldTripDue),
    amount: 15,
    forWhom: 'Maya',
    source: 'photo',
    sourceSnippet:
      `Dear Grade 4 Families, our class will visit the Bay Aquarium on ${longDate(fieldTripDate)}. ` +
      `Please sign the permission slip below and return it with $15 by ${longDate(fieldTripDue)}. Thank you! - Ms. Alvarez`,
    confidence: 0.91,
    addedBy: 'Priya',
    createdDaysAgo: 2,
  },
  {
    id: 'seed-water-bill',
    type: 'bill',
    title: 'Water bill',
    dueDate: iso(waterDue),
    amount: 84.2,
    forWhom: null,
    source: 'gmail',
    sourceSnippet:
      `Your Westbrook Water District statement is ready. Account ending in 4417. ` +
      `Amount due: $84.20. Due date: ${shortDate(waterDue)}. Pay online or set up AutoPay to avoid a late fee.`,
    confidence: 0.97,
    addedBy: 'Dan',
    createdDaysAgo: 9,
  },
  {
    id: 'seed-car-insurance',
    type: 'renewal',
    title: 'Car insurance renewal',
    dueDate: iso(insuranceDue),
    amount: 612,
    forWhom: null,
    source: 'gmail',
    sourceSnippet:
      `Your Harborline auto policy HL-55102 renews on ${shortDate(insuranceDue)}. ` +
      `Your new 6-month premium is $612.00. Renew online before then to keep your coverage.`,
    confidence: 0.95,
    addedBy: 'Dan',
    createdDaysAgo: 6,
    email: demoEmail('harborline-renewal', 'Harborline Insurance', 'renewals@harborline.example', 'Your auto policy HL-55102 is up for renewal'),
    links: [{ url: 'https://www.harborline.example/policies/HL-55102/renew', kind: 'renewal', label: 'Renew your policy' }],
  },
  {
    id: 'seed-amazon-delivery',
    type: 'order',
    title: 'Amazon delivery: kids rain boots',
    dueDate: iso(deliveryAt),
    amount: null,
    forWhom: null,
    source: 'gmail',
    sourceSnippet:
      `Arriving ${longDate(deliveryAt)} by ${time(deliveryAt)}. Your package with "Kids' Waterproof Rain Boots" ` +
      `and 1 other item is on the way. Order #113-4829105-7730612.`,
    confidence: 0.98,
    addedBy: 'Priya',
    createdDaysAgo: 1,
  },
  {
    id: 'seed-dentist',
    type: 'appointment',
    title: 'Dentist appointment',
    dueDate: iso(dentistAt),
    amount: null,
    forWhom: 'Maya',
    source: 'gmail',
    sourceSnippet:
      `Hi Priya, this is Bright Smiles Dental confirming Maya's cleaning with Dr. Okafor on ${longDate(dentistAt)} at ${time(dentistAt)}. ` +
      `Just reply to this email if you need to reschedule.`,
    confidence: 0.9,
    addedBy: 'Priya',
    createdDaysAgo: 5,
    email: demoEmail('bright-smiles-cleaning', 'Bright Smiles Dental', 'dr.smile@brightsmiles.example', "Maya's cleaning appointment"),
  },
  {
    id: 'seed-movie-booking',
    type: 'booking',
    title: 'Family movie night tickets',
    dueDate: iso(movieAt),
    amount: null,
    forWhom: null,
    source: 'gmail',
    sourceSnippet:
      `You're all set! 4 tickets, Auditorium 7, ${longDate(movieAt)} at ${time(movieAt)}. ` +
      `Booking reference K7Q2ZP. Show this email or the QR code at the door.`,
    confidence: 0.96,
    addedBy: 'Dan',
    createdDaysAgo: 3,
  },
  {
    id: 'seed-parent-teacher',
    type: 'appointment',
    title: 'Parent-teacher conference',
    dueDate: iso(conferenceAt),
    amount: null,
    forWhom: 'Leo',
    source: 'whatsapp',
    sourceSnippet:
      `Reminder from Mrs. Chen: Room 12 parent-teacher conferences are coming up. ` +
      `Leo's slot is ${longDate(conferenceAt)} at ${time(conferenceAt)}, 15 minutes, in the classroom.`,
    confidence: 0.88,
    addedBy: 'Priya',
    createdDaysAgo: 4,
  },
  {
    id: 'seed-credit-card',
    type: 'bill',
    title: 'Credit card payment',
    dueDate: iso(cardDue),
    amount: 1243.57,
    forWhom: null,
    source: 'gmail',
    sourceSnippet:
      `Your statement is ready. Statement balance: $1,243.57. Minimum payment due: $35.00. ` +
      `Payment due date: ${shortDate(cardDue)}.`,
    confidence: 0.94,
    private: true,
    addedBy: 'Priya',
    createdDaysAgo: 7,
  },
  {
    id: 'seed-dishwasher-warranty',
    type: 'deadline',
    title: 'Dishwasher warranty expires',
    dueDate: iso(warrantyEnds),
    amount: null,
    forWhom: null,
    source: 'photo',
    sourceSnippet:
      `LIMITED WARRANTY - Model DW-4410. Parts and labor covered for 2 years from date of purchase. ` +
      `Coverage ends ${numericDate(warrantyEnds)}. Keep this card with your receipt.`,
    confidence: 0.79,
    addedBy: 'Dan',
    createdDaysAgo: 20,
  },
  {
    id: 'seed-rent',
    type: 'bill',
    title: 'Rent',
    dueDate: iso(rentDue),
    amount: 2450,
    forWhom: null,
    source: 'manual',
    sourceSnippet: `Remind us that rent, twenty-four fifty, is due on ${longDate(rentDue)}.`,
    confidence: 1,
    addedBy: 'Priya',
    status: 'done',
    doneBy: 'Dan',
    doneAt: iso(rentPaid),
    createdDaysAgo: 10,
  },
];

const obligations = seeds.map(({ createdDaysAgo, ...s }) =>
  ObligationSchema.parse({
    householdId,
    currency: config.DEFAULT_CURRENCY,
    status: 'pending',
    doneBy: null,
    doneAt: null,
    private: false,
    needsConfirmation: false,
    confirmationQuestion: null,
    confirmationOptions: [],
    email: null,
    links: [],
    actions: [],
    createdAt: iso(at(-createdDaysAgo, 9)),
    ...s,
  } satisfies Obligation),
);

try {
  if (reset) {
    const removed = await store.clearHousehold(householdId);
    console.log(`Cleared ${removed} existing item(s) from household "${householdId}".`);
    const gmail = await new GmailState(config.GMAIL_STATE_FILE).update((g) => {
      g.processed = {};
      g.lastSyncAt = null;
    });
    if (gmail.refreshToken) console.log(`Gmail (${gmail.account}) stays connected; the next sync reads recent emails again.`);
  }
  for (const o of obligations) await store.put(o);
  console.log(`Seeded ${obligations.length} obligations into ${store.describe()} for household "${householdId}" (${tz}):`);
  for (const o of obligations) {
    const flags = [o.private ? `private to ${o.addedBy}` : '', o.status === 'done' ? `done by ${o.doneBy}` : '']
      .filter(Boolean)
      .join(', ');
    console.log(`  ${o.dueDate}  ${o.type.padEnd(11)} ${o.title}${flags ? `  (${flags})` : ''}`);
  }
} catch (err) {
  console.error('Seeding failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
}

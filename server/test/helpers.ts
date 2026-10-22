import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Obligation } from '@fridge-door/shared';
import type { JsonRequest, LlmProvider, TextRequest } from '../src/llm/types.js';
import { LocalJsonStore } from '../src/store/local.js';

export const TZ = 'America/Los_Angeles';
export const HOUSEHOLD = 'test-household';

/** Wed 2026-10-21 10:00 PDT */
export const NOW = Date.parse('2026-10-21T17:00:00Z');

export function ob(overrides: Partial<Obligation> & Pick<Obligation, 'id' | 'title' | 'dueDate'>): Obligation {
  return {
    householdId: HOUSEHOLD,
    type: 'bill',
    amount: null,
    currency: 'USD',
    forWhom: null,
    source: 'manual',
    sourceSnippet: `snippet for ${overrides.title}`,
    confidence: 1,
    private: false,
    addedBy: 'Priya',
    status: 'pending',
    doneBy: null,
    doneAt: null,
    createdAt: '2026-10-01T16:00:00.000Z',
    needsConfirmation: false,
    confirmationQuestion: null,
    ...overrides,
  };
}

export async function tempStore(): Promise<{ store: LocalJsonStore; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fridge-door-test-'));
  return {
    store: new LocalJsonStore(path.join(dir, 'obligations.json')),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** A fixed set used across tests. Times are relative to NOW (Wed Oct 21, 10:00 PDT). */
export const FIXTURES: Obligation[] = [
  ob({ id: 'water', title: 'Water bill', dueDate: '2026-10-23T06:59:59.999Z', amount: 84.2 }), // Thu end of day PDT
  ob({ id: 'dentist', type: 'appointment', title: 'Dentist appointment', forWhom: 'Maya', dueDate: '2026-10-24T22:30:00.000Z' }), // Sat 3:30 PM
  ob({ id: 'today-appt', type: 'appointment', title: 'Vet checkup', dueDate: '2026-10-21T23:00:00.000Z' }), // today 4 PM
  ob({ id: 'delivery', type: 'order', title: 'Amazon delivery: rain boots', dueDate: '2026-10-22T03:00:00.000Z' }), // today 8 PM
  ob({ id: 'card', title: 'Credit card payment', dueDate: '2026-10-27T06:59:59.999Z', amount: 1243.57, private: true, addedBy: 'Priya' }),
  ob({ id: 'rent', title: 'Rent', dueDate: '2026-10-25T06:59:59.999Z', amount: 2450, status: 'done', doneBy: 'Dan', doneAt: '2026-10-21T02:12:00.000Z' }),
  ob({ id: 'overdue', title: 'Library books', type: 'deadline', dueDate: '2026-10-19T06:59:59.999Z' }), // Sat Oct 18
  ob({ id: 'insurance', type: 'renewal', title: 'Car insurance renewal', dueDate: '2026-11-15T07:59:59.999Z', amount: 612 }),
  ob({ id: 'water-old', title: 'Water bill', dueDate: '2026-09-22T06:59:59.999Z', amount: 80, status: 'done', doneBy: 'Priya', doneAt: '2026-09-20T18:00:00.000Z' }),
];

/** Stands in for Gemini/Bedrock: returns canned JSON and transcripts, and records every request. */
export class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly jsonRequests: JsonRequest[] = [];
  readonly textRequests: TextRequest[] = [];

  constructor(
    private readonly items: unknown[] = [],
    private readonly transcript = '',
  ) {}

  async generateText(req: TextRequest): Promise<string> {
    this.textRequests.push(req);
    return this.transcript;
  }

  async generateJson(req: JsonRequest): Promise<unknown> {
    this.jsonRequests.push(req);
    return { items: this.items };
  }
}

/** A model item with every field the response schema requires. */
export function raw(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'bill',
    title: 'Something',
    dueDate: '2026-10-30',
    dueTime: null,
    amount: null,
    currency: null,
    forWhom: null,
    confidence: 0.9,
    needsConfirmation: false,
    alternativeDueDate: null,
    confirmationQuestion: null,
    ...overrides,
  };
}

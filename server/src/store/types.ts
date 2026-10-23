import type { Obligation } from '@fridge-door/shared';

/**
 * Persistence boundary. Everything is partitioned by household; access control
 * (private items) is applied above this layer, in the service.
 */
export interface ObligationStore {
  /** All obligations for a household, in no particular order. */
  list(householdId: string): Promise<Obligation[]>;
  get(householdId: string, id: string): Promise<Obligation | null>;
  /** Insert or replace. */
  put(obligation: Obligation): Promise<void>;
  /**
   * Marks an obligation done. Returns the updated record, or null if it does
   * not exist. Any open status (pending, awaiting_reply, renewal_in_progress) can
   * be marked done. Implementations must not overwrite an existing `done` status
   * (first person to finish it wins) and should return the current record instead.
   */
  markDone(householdId: string, id: string, doneBy: string, doneAt: string): Promise<Obligation | null>;
  /** Removes every obligation in a household (used by the seed script). */
  clearHousehold(householdId: string): Promise<number>;
  describe(): string;
}

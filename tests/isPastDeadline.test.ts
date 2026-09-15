/**
 * isPastDeadline.test.ts — unit tests for the client-side deadline hint.
 *
 * See src/api/isPastDeadline.ts for why this is split out and what it is
 * NOT (the actual enforcement, which is on-chain via blockTimeLt).
 */
import { isPastDeadline } from '../src/api/isPastDeadline.js';

describe('isPastDeadline', () => {
  it('returns false when no deadline is set (closesAt = 0)', () => {
    expect(isPastDeadline({ closesAt: 0n })).toBe(false);
  });

  it('returns false for a deadline far in the future', () => {
    const farFuture = BigInt(Math.floor(Date.now() / 1000)) + 3600n; // +1 hour
    expect(isPastDeadline({ closesAt: farFuture })).toBe(false);
  });

  it('returns true for a deadline in the past', () => {
    const past = BigInt(Math.floor(Date.now() / 1000)) - 3600n; // -1 hour
    expect(isPastDeadline({ closesAt: past })).toBe(true);
  });

  it('returns true exactly at the deadline instant (inclusive)', () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    expect(isPastDeadline({ closesAt: now })).toBe(true);
  });

  it('returns false one second before the deadline', () => {
    const almostNow = BigInt(Math.floor(Date.now() / 1000)) + 1n;
    expect(isPastDeadline({ closesAt: almostNow })).toBe(false);
  });
});

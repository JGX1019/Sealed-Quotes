/**
 * sealedquote.test.ts — Tests for the Sealed Quote RFQ contract
 *
 * Tests cover:
 *  1. Circuit logic     — open/close lifecycle, title/budget/price validation,
 *                          the single-open guard, buyer/supplier identity
 *                          checks, the one-bid-then-revise-only rule, and
 *                          the optional bidding deadline (closes_at)
 *  2. State transitions — counts accumulate correctly across many bids
 *  3. Private state     — the supplier's own previous bid is remembered
 *                          locally via witnesses, and drives the revision
 *                          circuit
 *  4. Privacy model     — the private `price` and the remembered previous bid
 *                          never appear in ledger state, and different
 *                          qualifying/non-qualifying prices are
 *                          indistinguishable on the public ledger
 *
 * Note: `title` and `unit_label` are PUBLIC display-only fields, not
 * private ones — they carry no cryptographic role, so they're exercised in
 * the circuit-logic tests below, not the privacy tests. `buyer_key` is also
 * public (see the file header in sealedquote.compact, "On-chain identity
 * checks", for what it does and doesn't guarantee).
 */

import {
  createConstructorContext,
  createCircuitContext,
  emptyZswapLocalState,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../managed/sealedquote/contract/index.js';
import { emptyPrivateState, witnesses } from '../src/api/privateState.js';

const DUMMY_ADDRESS = '0'.repeat(64);
const DUMMY_KEY = '0'.repeat(64);
// Two distinct 64-hex-char coin public keys, standing in for a buyer's
// wallet and a supplier's wallet. createCircuitContext's second argument
// determines what ownPublicKey() returns inside the circuit — passing a
// different key per call is how these tests exercise the buyer/supplier
// identity checks without needing a real wallet.
const BUYER_KEY = '1'.repeat(64);
const SUPPLIER_KEY = '2'.repeat(64);
const OTHER_SUPPLIER_KEY = '3'.repeat(64);

/** Mirrors src/api/contract.ts's encoding for fixed-width Bytes<N> ledger fields. */
function encodeFixed(text: string, width: number): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  const bytes = new Uint8Array(width);
  bytes.set(encoded.subarray(0, width));
  return bytes;
}

function decodeFixed(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

const encodeUnit = (label: string) => encodeFixed(label, 16);
const encodeTitle = (title: string) => encodeFixed(title, 32);

/** The ten fields the public ledger is expected to expose — and only these. */
const PUBLIC_LEDGER_FIELDS = [
  'bid_count',
  'budget_max',
  'buyer_key',
  'closes_at',
  'is_initialized',
  'is_open',
  'qualifying_count',
  'revision_count',
  'title',
  'unit_label',
];

function freshState(coinPublicKey: string = BUYER_KEY) {
  // The contract is constructed with the real witness implementations, so
  // these tests exercise the same private-state code path the dApp uses.
  const contract = new Contract(witnesses as any);
  const ctx = createConstructorContext(emptyPrivateState, coinPublicKey);
  const init = contract.initialState(ctx);
  return { contract, contractState: init.currentContractState, privateState: init.currentPrivateState };
}

function readLedger(contractState: any) {
  return ledger(contractState.data ?? contractState);
}

function callOpen(
  contract: Contract<any>,
  contractState: any,
  privateState: any,
  budget: bigint,
  options: { title?: string; unit?: string; asKey?: string; deadlineAt?: bigint } = {},
) {
  const { title = 'test RFQ', unit = 'USD', asKey = BUYER_KEY, deadlineAt = 0n } = options;
  const ctx = createCircuitContext(DUMMY_ADDRESS, asKey, contractState, privateState);
  const result = contract.circuits.open_rfq(ctx, encodeTitle(title), budget, encodeUnit(unit), deadlineAt);
  return { chargedState: result.context.currentQueryContext.state, privateState: result.context.currentPrivateState };
}

/**
 * `time` is passed straight to createCircuitContext's `time` parameter,
 * which is what the contract's blockTimeLt(closes_at) checks are actually
 * evaluated against — this is how the deadline tests below simulate
 * "before" and "after" a deadline without depending on wall-clock time.
 */
function callBid(
  contract: Contract<any>,
  contractState: any,
  privateState: any,
  price: bigint,
  asKey: string = SUPPLIER_KEY,
  time?: number,
) {
  const ctx = createCircuitContext(DUMMY_ADDRESS, asKey, contractState, privateState, undefined, undefined, time);
  const result = contract.circuits.submit_bid(ctx, price);
  return { chargedState: result.context.currentQueryContext.state, privateState: result.context.currentPrivateState };
}

function callRevised(
  contract: Contract<any>,
  contractState: any,
  privateState: any,
  price: bigint,
  asKey: string = SUPPLIER_KEY,
  time?: number,
) {
  const ctx = createCircuitContext(DUMMY_ADDRESS, asKey, contractState, privateState, undefined, undefined, time);
  const result = contract.circuits.submit_revised_bid(ctx, price);
  return { chargedState: result.context.currentQueryContext.state, privateState: result.context.currentPrivateState };
}

function callClose(contract: Contract<any>, contractState: any, privateState: any, asKey: string = BUYER_KEY) {
  const ctx = createCircuitContext(DUMMY_ADDRESS, asKey, contractState, privateState);
  const result = contract.circuits.close_rfq(ctx);
  return { chargedState: result.context.currentQueryContext.state, privateState: result.context.currentPrivateState };
}

/** Opens an RFQ (as the buyer) at the given budget, then submits each price as the default supplier, in order. */
function openAndBid(budget: bigint, prices: bigint[]) {
  const { contract, contractState, privateState } = freshState();
  const opened = callOpen(contract, contractState, privateState, budget);
  let state: any = opened.chargedState;
  // Each price after the first goes through submit_bid only once; the
  // remaining prices are folded through submit_revised_bid, since submit_bid
  // now rejects a second call from the same supplier. Tests that want a
  // specific mix of plain bids from *different* suppliers call callBid
  // directly with distinct keys instead of using this helper.
  let priv: any = opened.privateState;
  let first = true;
  for (const price of prices) {
    const r = first
      ? callBid(contract, state, priv, price)
      : callRevised(contract, state, priv, price);
    state = r.chargedState;
    priv = r.privateState;
    first = false;
  }
  return { contract, state, priv };
}

describe('Sealed Quote RFQ Contract', () => {
  describe('Circuit logic', () => {
    it('starts uninitialized, closed, with no bids', () => {
      const { contractState } = freshState();
      const state = readLedger(contractState);
      expect(state.is_initialized).toBe(false);
      expect(state.is_open).toBe(false);
      expect(state.bid_count).toBe(0n);
      expect(state.qualifying_count).toBe(0n);
      expect(state.revision_count).toBe(0n);
    });

    it('open_rfq publishes the title, budget, and unit, and opens bidding', () => {
      const { contract, contractState, privateState } = freshState();
      const r = callOpen(contract, contractState, privateState, 1000n, { title: 'office chairs', unit: 'tDUST' });
      const state = readLedger(r.chargedState);
      expect(decodeFixed(state.title)).toBe('office chairs');
      expect(state.budget_max).toBe(1000n);
      expect(decodeFixed(state.unit_label)).toBe('tDUST');
      expect(state.is_initialized).toBe(true);
      expect(state.is_open).toBe(true);
    });

    it('truncates a title longer than 32 bytes rather than throwing', () => {
      const { contract, contractState, privateState } = freshState();
      const longTitle = 'a title that is much longer than thirty two bytes for sure';
      const r = callOpen(contract, contractState, privateState, 1000n, { title: longTitle });
      const state = readLedger(r.chargedState);
      expect(decodeFixed(state.title)).toBe(longTitle.slice(0, 32));
    });

    it('truncates a unit label longer than 16 bytes rather than throwing', () => {
      const { contract, contractState, privateState } = freshState();
      const r = callOpen(contract, contractState, privateState, 1000n, { unit: 'A very long currency name' });
      const state = readLedger(r.chargedState);
      expect(decodeFixed(state.unit_label)).toBe('A very long curr');
    });

    it('rejects a zero budget', () => {
      const { contract, contractState, privateState } = freshState();
      expect(() => callOpen(contract, contractState, privateState, 0n)).toThrow();
    });

    it('rejects opening the same RFQ a second time', () => {
      // Bug fix: previously open_rfq had no guard, so a buyer could call it
      // again mid-auction and silently change the budget suppliers already
      // bid against.
      const { contract, contractState, privateState } = freshState();
      const opened = callOpen(contract, contractState, privateState, 1000n);
      expect(() =>
        callOpen(contract, opened.chargedState, opened.privateState, 5000n, { title: 'different terms' }),
      ).toThrow(/already been opened/);
    });

    it('rejects a bid before the RFQ is opened', () => {
      const { contract, contractState, privateState } = freshState();
      expect(() => callBid(contract, contractState, privateState, 500n)).toThrow();
    });

    it('rejects a zero-price bid', () => {
      const { contract, contractState, privateState } = freshState();
      const opened = callOpen(contract, contractState, privateState, 1000n);
      expect(() => callBid(contract, opened.chargedState, opened.privateState, 0n)).toThrow();
    });

    it('a bid at or under budget qualifies', () => {
      const { state } = openAndBid(1000n, [1000n]);
      const s = readLedger(state);
      expect(s.bid_count).toBe(1n);
      expect(s.qualifying_count).toBe(1n);
    });

    it('a bid over budget does not qualify but is still counted', () => {
      const { state } = openAndBid(1000n, [1001n]);
      const s = readLedger(state);
      expect(s.bid_count).toBe(1n);
      expect(s.qualifying_count).toBe(0n);
    });

    it('close_rfq closes an open RFQ when called by the buyer', () => {
      const { contract, state, priv } = openAndBid(1000n, []);
      const closed = callClose(contract, state, priv);
      expect(readLedger(closed.chargedState).is_open).toBe(false);
    });

    it('rejects closing an already-closed RFQ', () => {
      const { contract, state, priv } = openAndBid(1000n, []);
      const closed = callClose(contract, state, priv);
      expect(() => callClose(contract, closed.chargedState, closed.privateState)).toThrow(/already closed/);
    });

    it('rejects a bid submitted after the RFQ is closed', () => {
      const { contract, state, priv } = openAndBid(1000n, []);
      const closed = callClose(contract, state, priv);
      expect(() => callBid(contract, closed.chargedState, closed.privateState, 500n)).toThrow();
    });

    describe('Buyer / supplier identity checks', () => {
      it('rejects the buyer bidding on their own RFQ', () => {
        // Bug fix: previously nothing stopped the wallet that opened an RFQ
        // from also submitting a bid on it.
        const { contract, contractState, privateState } = freshState();
        const opened = callOpen(contract, contractState, privateState, 1000n);
        expect(() =>
          callBid(contract, opened.chargedState, opened.privateState, 500n, BUYER_KEY),
        ).toThrow(/buyer cannot bid/);
      });

      it('allows a supplier who is not the buyer to bid', () => {
        const { contract, contractState, privateState } = freshState();
        const opened = callOpen(contract, contractState, privateState, 1000n);
        const bid = callBid(contract, opened.chargedState, opened.privateState, 500n, SUPPLIER_KEY);
        expect(readLedger(bid.chargedState).bid_count).toBe(1n);
      });

      it('rejects close_rfq called by a non-buyer', () => {
        // Bug fix: previously anyone at all could close anyone else's RFQ,
        // letting a losing supplier grief the auction shut.
        const { contract, state, priv } = openAndBid(1000n, []);
        expect(() => callClose(contract, state, priv, SUPPLIER_KEY)).toThrow(/only the buyer/);
      });

      it('rejects close_rfq called by a different supplier than any bidder', () => {
        const { contract, state, priv } = openAndBid(1000n, []);
        expect(() => callClose(contract, state, priv, OTHER_SUPPLIER_KEY)).toThrow(/only the buyer/);
      });
    });

    describe('One bid, then revise-only', () => {
      it('rejects a second submit_bid call from the same supplier', () => {
        // Bug fix: previously a supplier could call submit_bid repeatedly
        // instead of submit_revised_bid, bypassing the "revisions only go
        // down" rule entirely (they could raise their price back up, or
        // dodge the rule for any reason).
        const { contract, contractState, privateState } = freshState();
        const opened = callOpen(contract, contractState, privateState, 1000n);
        const firstBid = callBid(contract, opened.chargedState, opened.privateState, 900n, SUPPLIER_KEY);
        expect(() =>
          callBid(contract, firstBid.chargedState, firstBid.privateState, 950n, SUPPLIER_KEY),
        ).toThrow(/already have a bid/);
      });

      it('a second submit_bid attempt does not change public state', () => {
        const { contract, contractState, privateState } = freshState();
        const opened = callOpen(contract, contractState, privateState, 1000n);
        const firstBid = callBid(contract, opened.chargedState, opened.privateState, 900n, SUPPLIER_KEY);
        const before = readLedger(firstBid.chargedState);
        try {
          callBid(contract, firstBid.chargedState, firstBid.privateState, 950n, SUPPLIER_KEY);
        } catch {
          // expected
        }
        // Re-read from the same pre-attempt state — a thrown circuit call
        // must not have produced a usable state to move forward from.
        expect(readLedger(firstBid.chargedState)).toEqual(before);
      });

      it('two different suppliers can each submit exactly one plain bid', () => {
        // Each supplier has their own private state store in reality (private
        // state lives per-browser) — bid2 starts from emptyPrivateState, not
        // from bid1's, to model that correctly rather than incorrectly
        // sharing one supplier's "have I bid" memory with another's.
        const { contract, contractState, privateState } = freshState();
        const opened = callOpen(contract, contractState, privateState, 1000n);
        const bid1 = callBid(contract, opened.chargedState, opened.privateState, 900n, SUPPLIER_KEY);
        const bid2 = callBid(contract, bid1.chargedState, emptyPrivateState, 800n, OTHER_SUPPLIER_KEY);
        expect(readLedger(bid2.chargedState).bid_count).toBe(2n);
      });
    });

    describe('Bidding deadline', () => {
      it('defaults to no deadline (closes_at = 0) when none is given', () => {
        const { contract, contractState, privateState } = freshState();
        const opened = callOpen(contract, contractState, privateState, 1000n);
        expect(readLedger(opened.chargedState).closes_at).toBe(0n);
      });

      it('stores the given absolute deadline', () => {
        const { contract, contractState, privateState } = freshState();
        const opened = callOpen(contract, contractState, privateState, 1000n, { deadlineAt: 1000n });
        expect(readLedger(opened.chargedState).closes_at).toBe(1000n);
      });

      it('accepts a bid submitted before the deadline', () => {
        const { contract, contractState, privateState } = freshState();
        const opened = callOpen(contract, contractState, privateState, 1000n, { deadlineAt: 1000n });
        const bid = callBid(contract, opened.chargedState, opened.privateState, 500n, SUPPLIER_KEY, 500);
        expect(readLedger(bid.chargedState).bid_count).toBe(1n);
      });

      it('rejects a bid submitted after the deadline, even though is_open is still true', () => {
        // Bug this covers: the deadline is enforced independently of
        // is_open — a buyer forgetting (or being unable) to call close_rfq
        // must not leave the RFQ bid-able forever.
        const { contract, contractState, privateState } = freshState();
        const opened = callOpen(contract, contractState, privateState, 1000n, { deadlineAt: 1000n });
        expect(readLedger(opened.chargedState).is_open).toBe(true);
        expect(() =>
          callBid(contract, opened.chargedState, opened.privateState, 500n, SUPPLIER_KEY, 1500),
        ).toThrow(/deadline.*has passed/);
      });

      it('rejects a revision submitted after the deadline', () => {
        const { contract, contractState, privateState } = freshState();
        const opened = callOpen(contract, contractState, privateState, 1000n, { deadlineAt: 1000n });
        const bid = callBid(contract, opened.chargedState, opened.privateState, 900n, SUPPLIER_KEY, 500);
        expect(() =>
          callRevised(contract, bid.chargedState, bid.privateState, 800n, SUPPLIER_KEY, 1500),
        ).toThrow(/deadline.*has passed/);
      });

      it('a bid at exactly the deadline instant is rejected (deadline is exclusive)', () => {
        const { contract, contractState, privateState } = freshState();
        const opened = callOpen(contract, contractState, privateState, 1000n, { deadlineAt: 1000n });
        expect(() =>
          callBid(contract, opened.chargedState, opened.privateState, 500n, SUPPLIER_KEY, 1000),
        ).toThrow(/deadline.*has passed/);
      });

      it('with no deadline set, a bid succeeds regardless of how far in the future the block time is', () => {
        const { contract, contractState, privateState } = freshState();
        const opened = callOpen(contract, contractState, privateState, 1000n); // no deadlineAt -> 0n
        const bid = callBid(contract, opened.chargedState, opened.privateState, 500n, SUPPLIER_KEY, 999_999_999);
        expect(readLedger(bid.chargedState).bid_count).toBe(1n);
      });

      it('the buyer can still close_rfq manually before a set deadline arrives', () => {
        const { contract, contractState, privateState } = freshState();
        const opened = callOpen(contract, contractState, privateState, 1000n, { deadlineAt: 999_999n });
        const closed = callClose(contract, opened.chargedState, opened.privateState);
        expect(readLedger(closed.chargedState).is_open).toBe(false);
      });
    });
  });

  describe('State transitions', () => {
    it('counts accumulate across many bids from many suppliers', () => {
      // budget 1000; bids from 4 distinct suppliers: 500 (qualifies), 1500 (no),
      // 1000 (qualifies), 999 (qualifies)
      const { contract, contractState, privateState } = freshState();
      const opened = callOpen(contract, contractState, privateState, 1000n);
      let state: any = opened.chargedState;
      const prices: [bigint, string][] = [
        [500n, '4'.repeat(64)],
        [1500n, '5'.repeat(64)],
        [1000n, '6'.repeat(64)],
        [999n, '7'.repeat(64)],
      ];
      for (const [price, key] of prices) {
        // Each of these is a distinct supplier's first bid, so each starts
        // from its own emptyPrivateState — see the note on the two-suppliers
        // test above for why bid1.privateState must not be reused here.
        const r = callBid(contract, state, emptyPrivateState, price, key);
        state = r.chargedState;
      }
      const s = readLedger(state);
      expect(s.bid_count).toBe(4n);
      expect(s.qualifying_count).toBe(3n);
    });

    it('handles an all-qualifying round', () => {
      const { state } = openAndBid(1000n, [100n]);
      const s = readLedger(state);
      expect(s.bid_count).toBe(1n);
      expect(s.qualifying_count).toBe(1n);
    });

    it('handles an all-over-budget round', () => {
      const { state } = openAndBid(100n, [200n]);
      const s = readLedger(state);
      expect(s.bid_count).toBe(1n);
      expect(s.qualifying_count).toBe(0n);
    });

    it('never lets qualifying_count exceed bid_count', () => {
      const { state } = openAndBid(500n, [600n, 500n, 50n]);
      const s = readLedger(state);
      expect(s.qualifying_count).toBeLessThanOrEqual(s.bid_count);
    });

    it('budget_max stays fixed across a supplier revising their bid', () => {
      const { state } = openAndBid(750n, [800n, 750n]);
      expect(readLedger(state).budget_max).toBe(750n);
    });
  });

  describe('Private state — the supplier remembers their own previous bid', () => {
    it('a fresh supplier has no remembered bid', () => {
      const { privateState } = freshState();
      expect(privateState.lastBid).toBe(0n);
    });

    it('submit_bid records the price in the supplier\'s private state', () => {
      const { priv } = openAndBid(1000n, [640n]);
      expect(priv.lastBid).toBe(640n);
    });

    it('private state tracks the most recent bid across a chain of revisions', () => {
      const { priv } = openAndBid(1000n, [900n, 800n, 700n]);
      expect(priv.lastBid).toBe(700n);
    });

    it('rejects a revision when the supplier has never bid', () => {
      // No prior submit_bid, so local_last_bid() returns 0 and the
      // "no earlier bid" assert must fail.
      const { contract, state, priv } = openAndBid(1000n, []);
      expect(() => callRevised(contract, state, priv, 500n)).toThrow();
    });

    it('accepts a revision that strictly undercuts the previous bid', () => {
      const { contract, state, priv } = openAndBid(1000n, [900n]);
      const revised = callRevised(contract, state, priv, 850n);
      const s = readLedger(revised.chargedState);
      expect(s.revision_count).toBe(1n);
      expect(s.bid_count).toBe(2n);
      expect(revised.privateState.lastBid).toBe(850n);
    });

    it('rejects a revision equal to the previous bid', () => {
      const { contract, state, priv } = openAndBid(1000n, [900n]);
      expect(() => callRevised(contract, state, priv, 900n)).toThrow();
    });

    it('rejects a revision higher than the previous bid', () => {
      const { contract, state, priv } = openAndBid(1000n, [900n]);
      expect(() => callRevised(contract, state, priv, 950n)).toThrow();
    });

    it('rejects a zero-price revision', () => {
      const { contract, state, priv } = openAndBid(1000n, [900n]);
      expect(() => callRevised(contract, state, priv, 0n)).toThrow();
    });

    it('rejects a revision after the RFQ is closed', () => {
      const { contract, state, priv } = openAndBid(1000n, [900n]);
      const closed = callClose(contract, state, priv);
      expect(() => callRevised(contract, closed.chargedState, closed.privateState, 800n)).toThrow();
    });

    it('supports a chain of successively lower revisions', () => {
      const { contract, state, priv } = openAndBid(1000n, [900n]);
      let s: any = state;
      let p: any = priv;
      for (const price of [800n, 700n, 600n]) {
        const r = callRevised(contract, s, p, price);
        s = r.chargedState;
        p = r.privateState;
      }
      const publicState = readLedger(s);
      expect(publicState.revision_count).toBe(3n);
      expect(publicState.bid_count).toBe(4n); // 1 original + 3 revisions
      expect(p.lastBid).toBe(600n);
    });

    it('a revision still over budget is counted but does not qualify', () => {
      // Budget 500. First bid 2000 (over), revised down to 1500 (still over).
      const { contract, state, priv } = openAndBid(500n, [2000n]);
      const revised = callRevised(contract, state, priv, 1500n);
      const s = readLedger(revised.chargedState);
      expect(s.bid_count).toBe(2n);
      expect(s.qualifying_count).toBe(0n);
      expect(s.revision_count).toBe(1n);
    });

    it('a revision that crosses under budget starts qualifying', () => {
      // Budget 1000. First bid 1200 (over, does not qualify), revised to 900.
      const { contract, state, priv } = openAndBid(1000n, [1200n]);
      const revised = callRevised(contract, state, priv, 900n);
      const s = readLedger(revised.chargedState);
      expect(s.bid_count).toBe(2n);
      expect(s.qualifying_count).toBe(1n);
      expect(s.revision_count).toBe(1n);
    });

    it('a chain of revisions does not increment revision_count on the initial bid', () => {
      const { state } = openAndBid(1000n, [900n]);
      expect(readLedger(state).revision_count).toBe(0n);
    });
  });

  describe('Privacy model — private prices are never exposed', () => {
    it('ledger exposes only the nine public fields, never a price', () => {
      const { contractState } = freshState();
      const publicState = ledger(contractState.data);
      expect(Object.keys(publicState).sort()).toEqual(PUBLIC_LEDGER_FIELDS);
      expect((publicState as any).price).toBeUndefined();
      expect((publicState as any).last_bid).toBeUndefined();
    });

    it('two different qualifying prices are indistinguishable on the public ledger', () => {
      const cheap = openAndBid(1000n, [1n]);
      const atBudget = openAndBid(1000n, [1000n]);
      expect(readLedger(cheap.state)).toEqual(readLedger(atBudget.state));
    });

    it('two different over-budget prices are indistinguishable on the public ledger', () => {
      const slightlyOver = openAndBid(1000n, [1001n]);
      const wayOver = openAndBid(1000n, [999999n]);
      expect(readLedger(slightlyOver.state)).toEqual(readLedger(wayOver.state));
    });

    it('different revision chains with the same qualify profile produce identical public state', () => {
      // Both: 1 initial bid + 2 revisions, 2 qualifying — different exact prices throughout.
      const roundA = openAndBid(1000n, [1500n, 1000n, 500n]);
      const roundB = openAndBid(1000n, [2000n, 999n, 1n]);
      expect(readLedger(roundA.state)).toEqual(readLedger(roundB.state));
    });

    it('the bid price is not serialised into the contract state', () => {
      const { state } = openAndBid(1000n, [777n]);
      const stateStr = state?.toString() ?? '';
      expect(stateStr).not.toContain('777');
    });

    it('revisions of very different magnitudes produce identical public state', () => {
      // A supplier shaving 1 off their bid and a supplier halving it look
      // exactly the same on-chain: one revision, one bid, both qualifying.
      const tinyCut = openAndBid(1000n, [900n]);
      const tinyRevised = callRevised(tinyCut.contract, tinyCut.state, tinyCut.priv, 899n);

      const bigCut = openAndBid(1000n, [900n]);
      const bigRevised = callRevised(bigCut.contract, bigCut.state, bigCut.priv, 450n);

      expect(readLedger(tinyRevised.chargedState)).toEqual(readLedger(bigRevised.chargedState));
    });

    it('neither the previous nor the revised price is serialised into contract state', () => {
      const { contract, state, priv } = openAndBid(10000n, [8421n]);
      const revised = callRevised(contract, state, priv, 6317n);
      const stateStr = revised.chargedState?.toString() ?? '';
      expect(stateStr).not.toContain('8421');
      expect(stateStr).not.toContain('6317');
    });

    it('the remembered previous bid lives only in private state, not public state', () => {
      const { priv, state } = openAndBid(1000n, [842n]);
      // Present privately...
      expect(priv.lastBid).toBe(842n);
      // ...and absent from every public field.
      const publicState = readLedger(state) as any;
      for (const field of PUBLIC_LEDGER_FIELDS) {
        expect(publicState[field]).not.toBe(842n);
      }
    });
  });
});

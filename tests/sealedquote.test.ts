/**
 * sealedquote.test.ts — Tests for the Sealed Quote RFQ contract
 *
 * Tests cover:
 *  1. Circuit logic     — open/close lifecycle, bid validity, budget checks
 *  2. State transitions — counts accumulate correctly across many bids
 *  3. Private state     — the supplier's own previous bid is remembered
 *                          locally via witnesses, and drives the revision
 *                          circuit
 *  4. Privacy model     — the private `price` and the remembered previous bid
 *                          never appear in ledger state, and different
 *                          qualifying/non-qualifying prices are
 *                          indistinguishable on the public ledger
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

/** The five fields the public ledger is expected to expose — and only these. */
const PUBLIC_LEDGER_FIELDS = [
  'bid_count',
  'budget_max',
  'is_open',
  'qualifying_count',
  'revision_count',
];

function freshState() {
  // The contract is constructed with the real witness implementations, so these
  // tests exercise the same private-state code path the dApp uses.
  const contract = new Contract(witnesses as any);
  const ctx = createConstructorContext(emptyPrivateState, DUMMY_ADDRESS);
  const init = contract.initialState(ctx);
  return { contract, contractState: init.currentContractState, privateState: init.currentPrivateState };
}

function readLedger(contractState: any) {
  return ledger(contractState.data ?? contractState);
}

function callOpen(contract: Contract<any>, contractState: any, privateState: any, budget: bigint) {
  const ctx = createCircuitContext(DUMMY_ADDRESS, emptyZswapLocalState(DUMMY_KEY), contractState, privateState);
  const result = contract.circuits.open_rfq(ctx, budget);
  return { chargedState: result.context.currentQueryContext.state, privateState: result.context.currentPrivateState };
}

function callBid(contract: Contract<any>, contractState: any, privateState: any, price: bigint) {
  const ctx = createCircuitContext(DUMMY_ADDRESS, emptyZswapLocalState(DUMMY_KEY), contractState, privateState);
  const result = contract.circuits.submit_bid(ctx, price);
  return { chargedState: result.context.currentQueryContext.state, privateState: result.context.currentPrivateState };
}

function callRevised(contract: Contract<any>, contractState: any, privateState: any, price: bigint) {
  const ctx = createCircuitContext(DUMMY_ADDRESS, emptyZswapLocalState(DUMMY_KEY), contractState, privateState);
  const result = contract.circuits.submit_revised_bid(ctx, price);
  return { chargedState: result.context.currentQueryContext.state, privateState: result.context.currentPrivateState };
}

function callClose(contract: Contract<any>, contractState: any, privateState: any) {
  const ctx = createCircuitContext(DUMMY_ADDRESS, emptyZswapLocalState(DUMMY_KEY), contractState, privateState);
  const result = contract.circuits.close_rfq(ctx);
  return { chargedState: result.context.currentQueryContext.state, privateState: result.context.currentPrivateState };
}

/** Opens an RFQ at the given budget, then submits each price in order. */
function openAndBid(budget: bigint, prices: bigint[]) {
  const { contract, contractState, privateState } = freshState();
  const opened = callOpen(contract, contractState, privateState, budget);
  let state: any = opened.chargedState;
  let priv: any = opened.privateState;
  for (const price of prices) {
    const r = callBid(contract, state, priv, price);
    state = r.chargedState;
    priv = r.privateState;
  }
  return { contract, state, priv };
}

describe('Sealed Quote RFQ Contract', () => {
  describe('Circuit logic', () => {
    it('starts closed with no bids', () => {
      const { contractState } = freshState();
      const state = readLedger(contractState);
      expect(state.is_open).toBe(false);
      expect(state.bid_count).toBe(0n);
      expect(state.qualifying_count).toBe(0n);
      expect(state.revision_count).toBe(0n);
    });

    it('open_rfq publishes the budget and opens bidding', () => {
      const { contract, contractState, privateState } = freshState();
      const r = callOpen(contract, contractState, privateState, 1000n);
      const state = readLedger(r.chargedState);
      expect(state.budget_max).toBe(1000n);
      expect(state.is_open).toBe(true);
    });

    it('rejects a zero budget', () => {
      const { contract, contractState, privateState } = freshState();
      expect(() => callOpen(contract, contractState, privateState, 0n)).toThrow();
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

    it('close_rfq closes an open RFQ', () => {
      const { contract, state, priv } = openAndBid(1000n, []);
      const closed = callClose(contract, state, priv);
      expect(readLedger(closed.chargedState).is_open).toBe(false);
    });

    it('rejects closing an already-closed RFQ', () => {
      const { contract, state, priv } = openAndBid(1000n, []);
      const closed = callClose(contract, state, priv);
      expect(() => callClose(contract, closed.chargedState, closed.privateState)).toThrow();
    });

    it('rejects a bid submitted after the RFQ is closed', () => {
      const { contract, state, priv } = openAndBid(1000n, []);
      const closed = callClose(contract, state, priv);
      expect(() => callBid(contract, closed.chargedState, closed.privateState, 500n)).toThrow();
    });
  });

  describe('State transitions', () => {
    it('counts accumulate across many bids from many suppliers', () => {
      // budget 1000; bids: 500 (qualifies), 1500 (no), 1000 (qualifies), 999 (qualifies)
      const { state } = openAndBid(1000n, [500n, 1500n, 1000n, 999n]);
      const s = readLedger(state);
      expect(s.bid_count).toBe(4n);
      expect(s.qualifying_count).toBe(3n);
    });

    it('handles an all-qualifying round', () => {
      const { state } = openAndBid(1000n, [100n, 200n, 1000n]);
      const s = readLedger(state);
      expect(s.bid_count).toBe(3n);
      expect(s.qualifying_count).toBe(3n);
    });

    it('handles an all-over-budget round', () => {
      const { state } = openAndBid(100n, [200n, 300n, 1000n]);
      const s = readLedger(state);
      expect(s.bid_count).toBe(3n);
      expect(s.qualifying_count).toBe(0n);
    });

    it('never lets qualifying_count exceed bid_count', () => {
      const { state } = openAndBid(500n, [100n, 600n, 500n, 50n, 9999n]);
      const s = readLedger(state);
      expect(s.qualifying_count).toBeLessThanOrEqual(s.bid_count);
    });

    it('budget_max stays fixed once bidding starts', () => {
      const { state } = openAndBid(750n, [100n, 800n, 750n]);
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

    it('private state tracks the most recent bid across several bids', () => {
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

    it('plain bids do not increment revision_count', () => {
      const { state } = openAndBid(1000n, [900n, 800n, 700n]);
      expect(readLedger(state).revision_count).toBe(0n);
    });
  });

  describe('Privacy model — private prices are never exposed', () => {
    it('ledger exposes only the five public fields, never a price', () => {
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

    it('different bid sequences with the same qualify profile produce identical public state', () => {
      // Both: 3 bids, 2 qualifying — but entirely different exact prices.
      const roundA = openAndBid(1000n, [500n, 1500n, 1000n]);
      const roundB = openAndBid(1000n, [999n, 2000n, 1n]);
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

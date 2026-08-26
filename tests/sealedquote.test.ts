/**
 * sealedquote.test.ts — Tests for the Sealed Quote RFQ contract
 *
 * Tests cover:
 *  1. Circuit logic     — open/close lifecycle, bid validity, budget checks
 *  2. State transitions — counts accumulate correctly across many bids
 *  3. Privacy model      — the private `price` never appears in ledger state,
 *                          and different qualifying/non-qualifying prices are
 *                          indistinguishable on the public ledger
 */

import {
  createConstructorContext,
  createCircuitContext,
  emptyZswapLocalState,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger } from '../managed/sealedquote/contract/index.js';

const DUMMY_ADDRESS = '0'.repeat(64);
const DUMMY_KEY = '0'.repeat(64);

function freshState() {
  const contract = new Contract({});
  const ctx = createConstructorContext({}, DUMMY_ADDRESS);
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

  describe('Privacy model — private prices are never exposed', () => {
    it('ledger exposes only the four public fields, never a price', () => {
      const { contractState } = freshState();
      const publicState = ledger(contractState.data);
      expect(Object.keys(publicState).sort()).toEqual(['bid_count', 'budget_max', 'is_open', 'qualifying_count']);
      expect((publicState as any).price).toBeUndefined();
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
  });
});

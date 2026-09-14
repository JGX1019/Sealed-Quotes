/**
 * privateState.ts — the supplier-side private state for SealedQuote, and the
 * TypeScript implementations of the contract's witnesses.
 *
 * This is the private half of Midnight's dual ledger. Everything in
 * `SealedQuotePrivateState` lives only on the supplier's own machine: it is
 * read into circuits through witnesses, never serialised into a transaction,
 * and never written to the public ledger.
 *
 * The contract declares two witnesses (see contracts/sealedquote.compact):
 *
 *   witness local_last_bid(): Uint<64>;
 *   witness remember_bid(price: Uint<64>): [];
 *
 * A witness implementation receives a WitnessContext and returns a
 * `[nextPrivateState, returnValue]` pair. Returning a new private state is how
 * a circuit call persists private data — the runtime hands the returned state
 * back to the private state provider after the call succeeds.
 */
import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from '../contract/sealedquote.js';

/**
 * What a supplier remembers locally about their own bidding on one RFQ.
 *
 * `lastBid` is the price this supplier most recently submitted. It exists so
 * `submit_revised_bid` can prove a new bid undercuts the previous one without
 * either number being disclosed. 0n means "this supplier has not bid yet",
 * which the contract checks explicitly before allowing a revision.
 */
export interface SealedQuotePrivateState {
  readonly lastBid: bigint;
}

/** The starting private state for a supplier who has not yet bid. */
export const emptyPrivateState: SealedQuotePrivateState = { lastBid: 0n };

/**
 * Identifier this contract's private state is stored under.
 *
 * A single constant is enough: the private state provider scopes every entry by
 * contract address (it requires `setContractAddress` before any read or write),
 * so a supplier's bid history on one RFQ is already isolated from another RFQ
 * without encoding the address here as well.
 */
export const PRIVATE_STATE_ID = 'sealedquote';

/**
 * Defensive normaliser. The private state provider returns `null` for a key it
 * has never seen, and a state deserialised from storage may predate a field
 * being added, so witnesses must not assume a well-formed object.
 */
function normalise(state: SealedQuotePrivateState | null | undefined): SealedQuotePrivateState {
  if (!state || typeof state.lastBid !== 'bigint') return emptyPrivateState;
  return state;
}

/**
 * Witness implementations for the sealedquote contract.
 *
 * Neither of these touches the network or the public ledger. `local_last_bid`
 * only reads local state; `remember_bid` only returns a new local state. The
 * price passed to `remember_bid` is a private circuit input, so it stays inside
 * the prover and this process.
 */
export const witnesses = {
  /** Reads the supplier's previous bid on this RFQ, or 0n if they haven't bid. */
  local_last_bid: (
    context: WitnessContext<Ledger, SealedQuotePrivateState>,
  ): [SealedQuotePrivateState, bigint] => {
    const current = normalise(context.privateState);
    return [current, current.lastBid];
  },

  /** Persists the price just bid so a later revision can be proven against it. */
  remember_bid: (
    context: WitnessContext<Ledger, SealedQuotePrivateState>,
    price: bigint,
  ): [SealedQuotePrivateState, []] => {
    const current = normalise(context.privateState);
    return [{ ...current, lastBid: price }, []];
  },
};

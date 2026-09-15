/**
 * isPastDeadline.ts — pure client-side hint for whether an RFQ's optional
 * bidding deadline has passed.
 *
 * Split into its own dependency-free module (rather than living inline in
 * contract.ts) specifically so it can be unit-tested directly — contract.ts
 * pulls in browser-only providers and isn't included in the Node test
 * tsconfig, but this file has no such dependency and can be.
 *
 * This is NOT the enforcement. The contract checks
 * `closes_at == 0 || blockTimeLt(closes_at)` against the block's own
 * timestamp at proof/execution time — a value neither the buyer nor the
 * supplier controls. This function exists purely so the UI can grey out the
 * bid forms and explain why, instead of letting someone build a proof the
 * chain is always going to reject. If this function and the chain ever
 * disagree (e.g. this device's clock is wrong), the chain wins; the UI
 * would just show a stale hint until the next refresh.
 */
export function isPastDeadline(rfq: { closesAt: bigint }): boolean {
  if (rfq.closesAt === 0n) return false;
  return BigInt(Math.floor(Date.now() / 1000)) >= rfq.closesAt;
}

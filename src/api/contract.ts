/**
 * contract.ts — deploy/join the SealedQuote RFQ contract and expose typed
 * circuit call helpers for the frontend.
 *
 * Uses the browser-side providers from providers.ts (backed by the
 * connected wallet) so proving, balancing, and submission all happen
 * through the wallet rather than a Node.js script.
 */
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { parseCoinPublicKeyToHex } from '@midnight-ntwrk/midnight-js-utils';
import { Contract, ledger } from '../contract/sealedquote.js';
import { buildProviders } from './providers.js';
import { emptyPrivateState, PRIVATE_STATE_ID, witnesses, type SealedQuotePrivateState } from './privateState.js';

// ZK assets are served as static files from public/managed/sealedquote —
// this must be re-copied (npm run copy-assets) every time the contract is
// recompiled. A stale copy here compiles and deploys fine but proves
// against the old circuit shape and fails opaquely at proof time.
const ZK_ASSETS_PATH = '/managed/sealedquote';

export interface RfqState {
  title: string;
  budgetMax: bigint;
  unitLabel: string;
  bidCount: bigint;
  qualifyingCount: bigint;
  revisionCount: bigint;
  isInitialized: boolean;
  isOpen: boolean;
  /** Absolute Unix-seconds deadline past which bids are rejected on-chain, or 0n for no deadline. */
  closesAt: bigint;
  /** Hex-encoded buyer coin public key, for the "is this caller the buyer?" check in the UI. */
  buyerKeyHex: string;
}

/** Fixed width of the contract's `Bytes<N>` display-label ledger fields. */
const UNIT_LABEL_BYTES = 16;
const TITLE_BYTES = 32;

/**
 * Encodes display text into a fixed-width byte array the contract expects.
 * Longer UTF-8 input is truncated to fit; shorter input is zero-padded,
 * which decodeFixedBytes below strips back off.
 */
function encodeFixedBytes(text: string, width: number): Uint8Array {
  const encoded = new TextEncoder().encode(text);
  const bytes = new Uint8Array(width);
  bytes.set(encoded.subarray(0, width));
  return bytes;
}

/** Reverses encodeFixedBytes: strips the zero padding, decodes UTF-8. */
function decodeFixedBytes(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function encodeUnitLabel(label: string): Uint8Array {
  return encodeFixedBytes(label, UNIT_LABEL_BYTES);
}

function encodeTitle(title: string): Uint8Array {
  return encodeFixedBytes(title, TITLE_BYTES);
}

/** Hex-encodes a coin public key for equality comparison in the UI. */
function coinPublicKeyToHex(key: { bytes: Uint8Array } | undefined | null): string {
  if (!key?.bytes) return '';
  return Array.from(key.bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Client-side timeout wrapper. callTx / deployContract can hang
 * indefinitely waiting on indexer finalization with zero UI feedback
 * otherwise — this doesn't affect the actual transaction, it just stops a
 * spinner from spinning forever with no explanation.
 */
function withTimeout<T>(promise: Promise<T>, ms = 120_000, label = 'operation'): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Binds the compiled contract to the real witness implementations. This
 * replaces the previous `withVacantWitnesses` — the contract now declares
 * `local_last_bid` and `remember_bid`, so vacant witnesses would fail at
 * circuit-call time the moment `submit_revised_bid` tried to read private
 * state.
 */
function buildCompiledContract() {
  // Built with the data-first overloads rather than `.pipe(...)`. The combinator
  // signatures resolve their witness/assets parameter through a conditional type
  // on the contract's remaining requirements, and piping our generated Contract
  // through them makes that conditional collapse to `never` (so every argument
  // becomes unassignable). Calling them directly with the target as the first
  // argument sidesteps the inference entirely.
  const base = CompiledContract.make('sealedquote', Contract as any);
  const withWitnesses = (CompiledContract.withWitnesses as any)(base, witnesses);
  return (CompiledContract.withCompiledFileAssets as any)(withWitnesses, ZK_ASSETS_PATH);
}

/**
 * Deploys a fresh RFQ contract (starts closed, with no budget set).
 *
 * `privateStateId` / `initialPrivateState` are required now that the contract
 * declares witnesses — midnight-js uses them to seed and locate the caller's
 * private state store for this contract.
 */
export async function deployRfq(connectedAPI: ConnectedAPI) {
  const providers = await buildProviders(connectedAPI);
  const compiledContract = buildCompiledContract();
  return withTimeout(
    deployContract(providers as any, {
      compiledContract: compiledContract as any,
      args: [],
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: emptyPrivateState,
    } as any),
    120_000,
    'Deploy',
  );
}

/**
 * Connects to an already-deployed RFQ contract by address.
 *
 * A supplier joining an RFQ they've bid on before will pick up their existing
 * private state from the provider; `initialPrivateState` only seeds the store
 * when nothing is present yet, so joining does not wipe a remembered bid.
 */
export async function joinRfq(connectedAPI: ConnectedAPI, contractAddress: string) {
  const providers = await buildProviders(connectedAPI);
  const compiledContract = buildCompiledContract();
  return withTimeout(
    findDeployedContract(providers as any, {
      contractAddress,
      compiledContract: compiledContract as any,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: emptyPrivateState,
    } as any),
    120_000,
    'Join',
  );
}

/**
 * Buyer action: publishes the title, budget ceiling, unit, and an optional
 * bidding deadline, and opens the RFQ for bids. Can only succeed once per
 * contract — the circuit asserts `!is_initialized`, so a second call (e.g.
 * trying to change the budget after bids exist) fails rather than silently
 * overwriting the terms suppliers already bid against.
 *
 * `title` is what the budget is for (e.g. "40 office chairs"). `unit` is a
 * display label ("USD", "USDC", "tDUST", ...) for what `budget` and every
 * submitted price are stated to be denominated in. Both are public,
 * on-chain, and informational only — the contract does not move or verify
 * any actual currency or interpret the title; see the header comment in
 * sealedquote.compact.
 *
 * `durationSeconds` is how long bidding should stay open, starting now.
 * Pass `0n` (or omit it) for no deadline — bidding then stays open until
 * the buyer calls `closeRfq`. When nonzero, this function computes the
 * absolute deadline (`now + durationSeconds`, in Unix seconds) and sends
 * that to the contract, which is what actually gets enforced on every
 * subsequent bid via `blockTimeLt` — checked against the block's own clock,
 * not this client's, so this computation only decides the deadline's
 * *value*, not whether it's honestly enforced afterward.
 */
export async function openRfq(
  deployedContract: any,
  title: string,
  budget: bigint,
  unit: string,
  durationSeconds: bigint = 0n,
) {
  const deadlineAt = durationSeconds > 0n ? BigInt(Math.floor(Date.now() / 1000)) + durationSeconds : 0n;
  const result: any = await withTimeout(
    deployedContract.callTx.open_rfq(encodeTitle(title), budget, encodeUnitLabel(unit), deadlineAt),
    120_000,
    'Open RFQ',
  );
  return result.public;
}

/**
 * Supplier action: submits a sealed bid. `price` is a PRIVATE circuit
 * input — it is consumed while generating the proof locally in the
 * browser and is never included in the submitted transaction, never
 * logged, and never returned from this function. Only the public
 * bid/qualifying counters change on-chain.
 */
export async function submitBid(deployedContract: any, price: bigint) {
  const result: any = await withTimeout(deployedContract.callTx.submit_bid(price), 120_000, 'Submit bid');
  return result.public;
}

/**
 * Supplier action: submits a revised bid that must undercut their own previous
 * bid on this RFQ.
 *
 * Both sides of that comparison are private. `price` is a private circuit
 * input, and the previous bid is read out of the caller's private state through
 * the `local_last_bid` witness — so the proof establishes "this is lower than
 * what I bid before" while neither number is disclosed to the buyer, to rival
 * suppliers, or to the chain. Publicly, only `revision_count` moves.
 */
export async function submitRevisedBid(deployedContract: any, price: bigint) {
  const result: any = await withTimeout(
    deployedContract.callTx.submit_revised_bid(price),
    120_000,
    'Submit revised bid',
  );
  return result.public;
}

/** Buyer action: closes the RFQ to further bids. */
export async function closeRfq(deployedContract: any) {
  const result: any = await withTimeout(deployedContract.callTx.close_rfq(), 120_000, 'Close RFQ');
  return result.public;
}

/**
 * Reads whether this browser has a remembered previous bid for the given RFQ.
 *
 * The UI needs to know whether to offer the "revise my bid" flow, but must not
 * display the remembered amount — showing it would defeat the point of proving
 * an improvement without disclosing either number. So this deliberately returns
 * only a boolean, never the price itself.
 */
export async function hasPreviousBid(connectedAPI: ConnectedAPI, contractAddress: string): Promise<boolean> {
  const providers = await buildProviders(connectedAPI);
  providers.privateStateProvider.setContractAddress(contractAddress as any);
  const state = (await providers.privateStateProvider.get(PRIVATE_STATE_ID)) as SealedQuotePrivateState | null;
  return !!state && typeof state.lastBid === 'bigint' && state.lastBid > 0n;
}

/** Reads the public RFQ state (title, budget, bid/qualifying/revision counts, open flag, buyer key). */
export async function readRfqState(connectedAPI: ConnectedAPI, contractAddress: string): Promise<RfqState | null> {
  const providers = await buildProviders(connectedAPI);
  const state = await providers.publicDataProvider.queryContractState(contractAddress as any);
  if (!state) return null;
  const publicState = ledger((state as any).data ?? state);
  return {
    title: decodeFixedBytes(publicState.title),
    budgetMax: publicState.budget_max,
    unitLabel: decodeFixedBytes(publicState.unit_label),
    bidCount: publicState.bid_count,
    qualifyingCount: publicState.qualifying_count,
    revisionCount: publicState.revision_count,
    isInitialized: publicState.is_initialized,
    isOpen: publicState.is_open,
    closesAt: publicState.closes_at,
    buyerKeyHex: coinPublicKeyToHex(publicState.buyer_key),
  };
}

export { isPastDeadline } from './isPastDeadline.js';

/**
 * Whether the currently connected wallet is the buyer who opened this RFQ.
 * Compares the wallet's own coin public key against the on-chain `buyer_key`
 * — the same comparison the contract itself makes via `ownPublicKey()` in
 * `submit_bid`/`close_rfq`, done here so the UI can hide actions the
 * contract would reject anyway (e.g. showing "Submit a bid" to the buyer,
 * or hiding "Close RFQ" from anyone but the buyer).
 *
 * This is a UI convenience, not the enforcement boundary — the contract's
 * own `ownPublicKey()` checks are what actually stop a disallowed call. See
 * "On-chain identity checks" in sealedquote.compact for the honest limits
 * of that guarantee.
 *
 * Bug fix: this previously compared `getCoinPublicKey()` directly against
 * `buyerKeyHex` as if both were hex. They weren't. `getCoinPublicKey()` is
 * wired (in providers.ts) to the wallet's `shieldedCoinPublicKey`, and the
 * DApp Connector API's own documentation is explicit that
 * `getShieldedAddresses()` returns everything in **Bech32m** format, not
 * hex. `buyerKeyHex` is hex — it comes from the ledger's `buyer_key` field
 * decoded byte-for-byte. Comparing a Bech32m string against a hex string is
 * never true, for anyone, including the actual buyer — so `isBuyer()`
 * always returned `false`, the "Close RFQ" button never rendered even for
 * the wallet that opened the RFQ, and "Your role" always read "Supplier."
 * midnight-js's own call/deploy path normalises the same value with
 * `parseCoinPublicKeyToHex(key, networkId)` before comparing or embedding
 * it in a transaction (see `createUnprovenCallTx` in
 * `@midnight-ntwrk/midnight-js-contracts`) — this now does the same.
 */
export async function isBuyer(connectedAPI: ConnectedAPI, buyerKeyHex: string): Promise<boolean> {
  if (!buyerKeyHex) return false;
  const providers = await buildProviders(connectedAPI); // calls setNetworkId(...) internally
  const ownKeyRaw = providers.walletProvider.getCoinPublicKey();
  if (!ownKeyRaw) return false;
  const ownKeyHex = parseCoinPublicKeyToHex(ownKeyRaw, getNetworkId());
  return ownKeyHex.toLowerCase() === buyerKeyHex.toLowerCase();
}

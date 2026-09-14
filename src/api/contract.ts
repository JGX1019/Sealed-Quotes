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
import { Contract, ledger } from '../contract/sealedquote.js';
import { buildProviders } from './providers.js';
import { emptyPrivateState, PRIVATE_STATE_ID, witnesses, type SealedQuotePrivateState } from './privateState.js';

// ZK assets are served as static files from public/managed/sealedquote —
// this must be re-copied (npm run copy-assets) every time the contract is
// recompiled. A stale copy here compiles and deploys fine but proves
// against the old circuit shape and fails opaquely at proof time.
const ZK_ASSETS_PATH = '/managed/sealedquote';

export interface RfqState {
  budgetMax: bigint;
  bidCount: bigint;
  qualifyingCount: bigint;
  revisionCount: bigint;
  isOpen: boolean;
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

/** Buyer action: publishes the budget ceiling and opens the RFQ for bids. */
export async function openRfq(deployedContract: any, budget: bigint) {
  const result: any = await withTimeout(deployedContract.callTx.open_rfq(budget), 120_000, 'Open RFQ');
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

/** Reads the public RFQ state (budget, bid count, qualifying count, open flag). */
export async function readRfqState(connectedAPI: ConnectedAPI, contractAddress: string): Promise<RfqState | null> {
  const providers = await buildProviders(connectedAPI);
  const state = await providers.publicDataProvider.queryContractState(contractAddress as any);
  if (!state) return null;
  const publicState = ledger((state as any).data ?? state);
  return {
    budgetMax: publicState.budget_max,
    bidCount: publicState.bid_count,
    qualifyingCount: publicState.qualifying_count,
    revisionCount: publicState.revision_count,
    isOpen: publicState.is_open,
  };
}

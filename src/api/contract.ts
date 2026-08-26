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

// ZK assets are served as static files from public/managed/sealedquote —
// this must be re-copied (npm run copy-assets) every time the contract is
// recompiled. A stale copy here compiles and deploys fine but proves
// against the old circuit shape and fails opaquely at proof time.
const ZK_ASSETS_PATH = '/managed/sealedquote';

export interface RfqState {
  budgetMax: bigint;
  bidCount: bigint;
  qualifyingCount: bigint;
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

function buildCompiledContract() {
  return CompiledContract.make('sealedquote', Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(ZK_ASSETS_PATH),
  );
}

/** Deploys a fresh RFQ contract (starts closed, with no budget set). */
export async function deployRfq(connectedAPI: ConnectedAPI) {
  const providers = await buildProviders(connectedAPI);
  const compiledContract = buildCompiledContract();
  return withTimeout(
    deployContract(providers as any, { compiledContract: compiledContract as any, args: [] } as any),
    120_000,
    'Deploy',
  );
}

/** Connects to an already-deployed RFQ contract by address. */
export async function joinRfq(connectedAPI: ConnectedAPI, contractAddress: string) {
  const providers = await buildProviders(connectedAPI);
  const compiledContract = buildCompiledContract();
  return withTimeout(
    findDeployedContract(providers as any, {
      contractAddress,
      compiledContract: compiledContract as any,
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

/** Buyer action: closes the RFQ to further bids. */
export async function closeRfq(deployedContract: any) {
  const result: any = await withTimeout(deployedContract.callTx.close_rfq(), 120_000, 'Close RFQ');
  return result.public;
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
    isOpen: publicState.is_open,
  };
}

/**
 * providers.ts — builds the ContractProviders set for browser-side contract
 * deployment and circuit calls, using the connected Midnight-compatible
 * wallet for proving, balancing, and submission instead of a Node.js
 * script wallet.
 *
 * This is the key architectural difference from the CLI deploy path
 * (src/deploy.ts): the wallet extension owns its own sync internally (it's
 * long-running and typically already synced), so the dApp never opens its
 * own raw indexer subscription the way the Node script does. That
 * sidesteps the sync-stall issue seen with the CLI deploy against Preprod.
 *
 * Private state is persisted through a real localStorage-backed provider
 * (browserPrivateStateProvider), not a no-op: the supplier's own previous
 * bid has to survive between transactions for `submit_revised_bid` to
 * prove an improvement against it.
 */
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { dappConnectorProofProvider } from '@midnight-ntwrk/midnight-js-dapp-connector-proof-provider';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import type { MidnightProvider, WalletProvider } from '@midnight-ntwrk/midnight-js-types';
import { fromHex, toHex } from '@midnight-ntwrk/midnight-js-utils';
import { browserPrivateStateProvider } from './browserPrivateStateProvider.js';
import type { SealedQuotePrivateState } from './privateState.js';

const CIRCUIT_IDS = ['open_rfq', 'submit_bid', 'submit_revised_bid', 'close_rfq'] as const;
type CircuitId = (typeof CIRCUIT_IDS)[number];

/**
 * Public Midnight indexer endpoints, keyed by network id.
 *
 * We deliberately do NOT use the `indexerUri` returned by the wallet's
 * getConfiguration(). Some wallets (1AM, for example) point that at their
 * own hosted indexer, which requires an API key and answers our
 * unauthenticated queries with 401 Unauthorized. The wallet needs that
 * endpoint for its own syncing; we only need public contract state, so we
 * read it from the network's public indexer instead.
 *
 * The wallet's networkId is still authoritative — it decides which of
 * these endpoints we talk to, so a wallet on Preview can't silently read
 * Preprod state.
 */
const PUBLIC_INDEXERS: Record<string, { http: string; ws: string }> = {
  preprod: {
    http: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    ws: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
  },
  preview: {
    http: 'https://indexer.preview.midnight.network/api/v4/graphql',
    ws: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  },
  undeployed: {
    http: 'http://localhost:8088/api/v4/graphql',
    ws: 'ws://localhost:8088/api/v4/graphql/ws',
  },
};

/**
 * Picks the indexer to read public contract state from. Prefers the known
 * public endpoint for the wallet's network; falls back to whatever the
 * wallet reported if we don't recognise the network id.
 */
function resolveIndexer(networkId: string, walletHttp: string, walletWs: string) {
  const known = PUBLIC_INDEXERS[networkId];
  if (known) return known;
  console.warn(`Unknown network id "${networkId}" — falling back to the wallet's indexer endpoint.`);
  return { http: walletHttp, ws: walletWs };
}

/**
 * Builds a WalletProvider + MidnightProvider pair backed by the connected
 * Lace wallet's balancing/signing/submission methods, plus a ProofProvider
 * that delegates proof generation to the wallet (proving happens locally
 * in the browser via Lace, not on our server).
 */
export async function buildProviders(connectedAPI: ConnectedAPI) {
  const config = await connectedAPI.getConfiguration();

  // The wallet's own network id decides which network we're really talking
  // to — set it globally before any contract operation, or midnight-js
  // throws "Network ID has not been configured".
  setNetworkId(config.networkId);

  const indexer = resolveIndexer(config.networkId, config.indexerUri, config.indexerWsUri);

  // FetchZkConfigProvider defaults to cross-fetch's `fetch` and calls it as
  // `this.fetchFunc(url, opts)` internally — since `this` there is the
  // provider instance (not `window`), the browser's native fetch throws
  // "Illegal invocation" (native fetch requires `window`/`self` as its
  // receiver). Passing a pre-bound window.fetch avoids that entirely.
  const zkConfigProvider = new FetchZkConfigProvider<CircuitId>(
    `${window.location.origin}/managed/sealedquote`,
    window.fetch.bind(window),
  );

  const walletAndMidnightProvider: WalletProvider & MidnightProvider = {
    getCoinPublicKey() {
      // Populated asynchronously below; see note in connectWallet.
      throw new Error('getCoinPublicKey called before wallet addresses were resolved');
    },
    getEncryptionPublicKey() {
      throw new Error('getEncryptionPublicKey called before wallet addresses were resolved');
    },
    async balanceTx(tx) {
      const { tx: balanced } = await connectedAPI.balanceUnsealedTransaction(serializeTx(tx));
      return deserializeFinalizedTx(balanced);
    },
    async submitTx(tx) {
      await connectedAPI.submitTransaction(serializeTx(tx));
      return tx.identifiers().at(-1) as any;
    },
  };

  const { shieldedCoinPublicKey, shieldedEncryptionPublicKey } = await connectedAPI.getShieldedAddresses();
  walletAndMidnightProvider.getCoinPublicKey = () => shieldedCoinPublicKey;
  walletAndMidnightProvider.getEncryptionPublicKey = () => shieldedEncryptionPublicKey;

  const proofProvider = await dappConnectorProofProvider(connectedAPI, zkConfigProvider, ledger.CostModel.initialCostModel());

  return {
    privateStateProvider: browserPrivateStateProvider<SealedQuotePrivateState>('sealedquote'),
    publicDataProvider: indexerPublicDataProvider(indexer.http, indexer.ws, window.WebSocket as any),
    zkConfigProvider,
    proofProvider,
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
}

function serializeTx(tx: unknown): string {
  return toHex((tx as { serialize: () => Uint8Array }).serialize());
}

function deserializeFinalizedTx(hex: string): ledger.FinalizedTransaction {
  return ledger.Transaction.deserialize('signature', 'proof', 'binding', fromHex(hex)) as any;
}

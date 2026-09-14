/**
 * network.ts — network config resolution, wallet seed persistence,
 * deployment recording.
 *
 * Self-contained, no SDK imports (keeps it testable in isolation).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type NetworkName = 'undeployed' | 'preview' | 'preprod';

export interface NetworkConfig {
  indexer: string;
  indexerWS: string;
  node: string;
  proofServer: string;
  faucet: string | null;
}

export const NETWORK_CONFIGS: Record<NetworkName, NetworkConfig> = {
  undeployed: {
    indexer: 'http://localhost:8088/api/v1/graphql',
    indexerWS: 'ws://localhost:8088/api/v1/graphql/ws',
    node: 'http://localhost:9944',
    proofServer: 'http://localhost:6300',
    faucet: null,
  },
  preview: {
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preview.midnight.network',
    proofServer: 'http://localhost:6300',
    faucet: 'https://faucet.preview.midnight.network',
  },
  preprod: {
    indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preprod.midnight.network',
    proofServer: 'http://localhost:6300',
    faucet: 'https://faucet.preprod.midnight.network',
  },
};

const STATE_FILE = path.resolve(process.cwd(), '.midnight-state.json');

interface MidnightState {
  seeds?: Record<string, string>;
  deployments?: Record<string, { contractAddress: string; deployedAt: string; network: string }>;
}

function loadState(): MidnightState {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state: MidnightState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/** Resolves the network from --network CLI flag, defaulting to "undeployed". */
export function resolveNetwork(): NetworkName {
  const idx = process.argv.indexOf('--network');
  const value = idx !== -1 ? process.argv[idx + 1] : undefined;
  if (value === 'preview' || value === 'preprod' || value === 'undeployed') {
    return value;
  }
  return 'undeployed';
}

/**
 * Returns a persisted wallet seed for the given network, generating and
 * saving a new random seed on first run. Reusing the same seed across
 * deploy runs avoids losing funded wallets.
 */
export function getOrCreateSeed(network: NetworkName): string {
  const state = loadState();
  state.seeds ??= {};
  if (state.seeds[network]) {
    return state.seeds[network];
  }
  const seed = randomBytes(32).toString('hex');
  state.seeds[network] = seed;
  saveState(state);
  return seed;
}

/** Records a successful deployment's contract address for the given network. */
export function recordDeployment(network: NetworkName, contractAddress: string): void {
  const state = loadState();
  state.deployments ??= {};
  state.deployments[network] = {
    contractAddress,
    deployedAt: new Date().toISOString(),
    network,
  };
  saveState(state);
}

/** Reads a previously recorded deployment for the given network, if any. */
export function getRecordedDeployment(network: NetworkName) {
  const state = loadState();
  return state.deployments?.[network];
}

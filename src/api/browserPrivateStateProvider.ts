/**
 * browserPrivateStateProvider.ts — a real, persisting PrivateStateProvider for
 * the browser, backed by localStorage.
 *
 * This is the storage layer for the private half of Midnight's dual ledger.
 * A supplier's `lastBid` has to outlive a single circuit call for
 * `submit_revised_bid` to be able to prove an improvement against it, which
 * means it has to survive a page reload — an in-memory Map would silently
 * reset the supplier's bid history every refresh and make the revision
 * circuit unusable in practice.
 *
 * Two implementation details worth knowing:
 *
 *  - Private state contains `bigint` values, and `JSON.stringify` throws on
 *    bigint ("Do not know how to serialize a BigInt"). The replacer/reviver
 *    pair below tags them so they round-trip losslessly instead of being
 *    silently coerced to Number and losing precision above 2^53.
 *
 *  - Keys are namespaced by contract address. midnight-js calls
 *    `setContractAddress` before any get/set, and the interface requires that
 *    scoping, so one supplier's bid history on RFQ A is not visible to RFQ B.
 *
 * Scope note: localStorage is plaintext on disk and readable by any script on
 * the same origin. That is acceptable here because this value never leaves the
 * user's own machine and the threat model is "the buyer, rival suppliers, and
 * chain observers must not learn the price" — none of whom can read it. It is
 * not sufficient against a local attacker who already has the device; a
 * production deployment should use the wallet's own encrypted private state
 * storage. This is called out in README under Privacy Model.
 */
import type { PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';

const PREFIX = 'sealedquote';
const BIGINT_TAG = '__bigint__';

/** Tags bigints so JSON.stringify doesn't throw and precision is preserved. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString() } : value;
}

/** Restores bigints tagged by `replacer`. */
function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && BIGINT_TAG in (value as Record<string, unknown>)) {
    return BigInt((value as Record<string, string>)[BIGINT_TAG]);
  }
  return value;
}

function readKey<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw, reviver) as T;
    // The interface treats a value that deserialises to undefined the same as
    // an absent key.
    return parsed === undefined ? null : parsed;
  } catch {
    // A corrupted entry should not wedge the app permanently — drop it and
    // behave as though the supplier has no stored state.
    console.warn(`Discarding unreadable private state at "${key}".`);
    localStorage.removeItem(key);
    return null;
  }
}

function writeKey(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value, replacer));
}

function removeMatching(predicate: (key: string) => boolean): void {
  const doomed: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && predicate(key)) doomed.push(key);
  }
  for (const key of doomed) localStorage.removeItem(key);
}

/**
 * Builds a localStorage-backed private state provider.
 *
 * @param storeName Namespace for this dApp's entries, so it can coexist with
 *   other Midnight dApps on the same origin.
 */
export function browserPrivateStateProvider<PS = any>(storeName = PREFIX): PrivateStateProvider<string, PS> {
  let contractAddress: string | null = null;

  const stateKey = (privateStateId: string): string => {
    if (contractAddress === null) {
      // Mirrors the documented behaviour of the official providers: reading or
      // writing private state without a scope is a programming error, not a
      // recoverable condition, and silently sharing state across contracts
      // would be a privacy bug.
      throw new Error(
        'setContractAddress must be called before reading or writing private state.',
      );
    }
    return `${storeName}.ps.${contractAddress}.${privateStateId}`;
  };

  const signingKeyKey = (address: string): string => `${storeName}.sk.${address}`;

  const unsupported = (operation: string) => async (): Promise<never> => {
    throw new Error(
      `${operation} is not supported by the localStorage private state provider. ` +
        'Encrypted export/import requires the wallet-backed provider.',
    );
  };

  return {
    setContractAddress(address) {
      contractAddress = address as unknown as string;
    },

    async set(privateStateId, state) {
      writeKey(stateKey(privateStateId), state);
    },

    async get(privateStateId) {
      return readKey<PS>(stateKey(privateStateId));
    },

    async remove(privateStateId) {
      localStorage.removeItem(stateKey(privateStateId));
    },

    async clear() {
      removeMatching((key) => key.startsWith(`${storeName}.ps.`));
    },

    async setSigningKey(address, signingKey) {
      writeKey(signingKeyKey(address as unknown as string), signingKey);
    },

    async getSigningKey(address) {
      return readKey(signingKeyKey(address as unknown as string));
    },

    async removeSigningKey(address) {
      localStorage.removeItem(signingKeyKey(address as unknown as string));
    },

    async clearSigningKeys() {
      removeMatching((key) => key.startsWith(`${storeName}.sk.`));
    },

    exportPrivateStates: unsupported('exportPrivateStates'),
    importPrivateStates: unsupported('importPrivateStates'),
    exportSigningKeys: unsupported('exportSigningKeys'),
    importSigningKeys: unsupported('importSigningKeys'),
  } as PrivateStateProvider<string, PS>;
}

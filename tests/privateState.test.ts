/**
 * privateState.test.ts — Tests for the private half of the dual ledger.
 *
 * Two units under test:
 *  1. The witness implementations (src/api/privateState.ts) — the functions the
 *     Compact circuits call to read and write supplier-local state.
 *  2. The localStorage-backed PrivateStateProvider
 *     (src/api/browserPrivateStateProvider.ts) — the store those values
 *     persist into between transactions.
 *
 * The provider is browser code, so these tests install a minimal localStorage
 * stub. That's deliberate: the bigint serialisation and contract-address
 * namespacing are exactly the parts most likely to break silently, and both are
 * privacy-relevant (a namespacing bug would leak one RFQ's bid history into
 * another).
 */
import { browserPrivateStateProvider } from '../src/api/browserPrivateStateProvider.js';
import { emptyPrivateState, witnesses, type SealedQuotePrivateState } from '../src/api/privateState.js';

/** Minimal in-memory Storage implementation matching the localStorage API. */
function createStorageStub(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
  } as Storage;
}

beforeEach(() => {
  (globalThis as any).localStorage = createStorageStub();
});

/** Builds a WitnessContext with just the field the witnesses actually read. */
function ctx(privateState: any) {
  return { ledger: {} as any, privateState, contractAddress: '0'.repeat(64) as any };
}

describe('Witness implementations', () => {
  describe('local_last_bid', () => {
    it('returns the remembered bid', () => {
      const [, value] = witnesses.local_last_bid(ctx({ lastBid: 725n }));
      expect(value).toBe(725n);
    });

    it('returns 0 for a supplier who has not bid', () => {
      const [, value] = witnesses.local_last_bid(ctx(emptyPrivateState));
      expect(value).toBe(0n);
    });

    it('returns 0 rather than throwing when private state is missing', () => {
      // The provider returns null for an unseen key, so the witness must cope.
      const [state, value] = witnesses.local_last_bid(ctx(null));
      expect(value).toBe(0n);
      expect(state).toEqual(emptyPrivateState);
    });

    it('returns 0 when the stored state is malformed', () => {
      const [, value] = witnesses.local_last_bid(ctx({ lastBid: 'not-a-bigint' }));
      expect(value).toBe(0n);
    });

    it('does not alter the private state it reads', () => {
      const before: SealedQuotePrivateState = { lastBid: 400n };
      const [after] = witnesses.local_last_bid(ctx(before));
      expect(after).toEqual(before);
    });
  });

  describe('remember_bid', () => {
    it('stores the price in the returned private state', () => {
      const [next] = witnesses.remember_bid(ctx(emptyPrivateState), 615n);
      expect(next.lastBid).toBe(615n);
    });

    it('overwrites an earlier remembered bid', () => {
      const [next] = witnesses.remember_bid(ctx({ lastBid: 900n }), 800n);
      expect(next.lastBid).toBe(800n);
    });

    it('does not mutate the private state passed in', () => {
      const before: SealedQuotePrivateState = { lastBid: 900n };
      witnesses.remember_bid(ctx(before), 100n);
      expect(before.lastBid).toBe(900n);
    });

    it('recovers from missing private state', () => {
      const [next] = witnesses.remember_bid(ctx(null), 250n);
      expect(next.lastBid).toBe(250n);
    });

    it('returns an empty tuple as its circuit-visible result', () => {
      const [, result] = witnesses.remember_bid(ctx(emptyPrivateState), 250n);
      expect(result).toEqual([]);
    });
  });
});

describe('Browser private state provider', () => {
  const ADDRESS_A = 'a'.repeat(64);
  const ADDRESS_B = 'b'.repeat(64);

  it('refuses to read or write before a contract address is set', async () => {
    const provider = browserPrivateStateProvider();
    // Without scoping, entries from different RFQs would collide.
    await expect(provider.get('sealedquote')).rejects.toThrow(/setContractAddress/);
    await expect(provider.set('sealedquote', { lastBid: 1n })).rejects.toThrow(/setContractAddress/);
  });

  it('returns null for a key it has never seen', async () => {
    const provider = browserPrivateStateProvider();
    provider.setContractAddress(ADDRESS_A as any);
    expect(await provider.get('sealedquote')).toBeNull();
  });

  it('round-trips a bigint private state without loss', async () => {
    const provider = browserPrivateStateProvider();
    provider.setContractAddress(ADDRESS_A as any);
    await provider.set('sealedquote', { lastBid: 1234n });
    const loaded = (await provider.get('sealedquote')) as SealedQuotePrivateState;
    expect(loaded.lastBid).toBe(1234n);
    expect(typeof loaded.lastBid).toBe('bigint');
  });

  it('preserves bigints beyond Number.MAX_SAFE_INTEGER', async () => {
    // A naive JSON round-trip through Number would silently corrupt this.
    const huge = 2n ** 60n + 7n;
    expect(huge > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);

    const provider = browserPrivateStateProvider();
    provider.setContractAddress(ADDRESS_A as any);
    await provider.set('sealedquote', { lastBid: huge });
    const loaded = (await provider.get('sealedquote')) as SealedQuotePrivateState;
    expect(loaded.lastBid).toBe(huge);
  });

  it('persists across provider instances on the same origin', async () => {
    // Models a page reload: new provider object, same underlying storage.
    const first = browserPrivateStateProvider();
    first.setContractAddress(ADDRESS_A as any);
    await first.set('sealedquote', { lastBid: 555n });

    const second = browserPrivateStateProvider();
    second.setContractAddress(ADDRESS_A as any);
    const loaded = (await second.get('sealedquote')) as SealedQuotePrivateState;
    expect(loaded.lastBid).toBe(555n);
  });

  it('isolates private state between contract addresses', async () => {
    const provider = browserPrivateStateProvider();

    provider.setContractAddress(ADDRESS_A as any);
    await provider.set('sealedquote', { lastBid: 100n });

    provider.setContractAddress(ADDRESS_B as any);
    expect(await provider.get('sealedquote')).toBeNull();

    await provider.set('sealedquote', { lastBid: 200n });
    expect(((await provider.get('sealedquote')) as SealedQuotePrivateState).lastBid).toBe(200n);

    // Switching back must still see the original RFQ's value.
    provider.setContractAddress(ADDRESS_A as any);
    expect(((await provider.get('sealedquote')) as SealedQuotePrivateState).lastBid).toBe(100n);
  });

  it('removes a single private state entry', async () => {
    const provider = browserPrivateStateProvider();
    provider.setContractAddress(ADDRESS_A as any);
    await provider.set('sealedquote', { lastBid: 1n });
    await provider.remove('sealedquote');
    expect(await provider.get('sealedquote')).toBeNull();
  });

  it('discards a corrupted entry instead of throwing', async () => {
    // The provider warns on discard by design. Swap console.warn out directly
    // rather than using jest.spyOn — the `jest` global isn't available under
    // --experimental-vm-modules without importing @jest/globals.
    const original = console.warn;
    let warned = 0;
    console.warn = () => {
      warned += 1;
    };
    try {
      const provider = browserPrivateStateProvider();
      provider.setContractAddress(ADDRESS_A as any);
      localStorage.setItem(`sealedquote.ps.${ADDRESS_A}.sealedquote`, '{ this is not json');
      expect(await provider.get('sealedquote')).toBeNull();
      expect(warned).toBe(1);
      // The bad entry should also be evicted, not left to fail again.
      expect(localStorage.getItem(`sealedquote.ps.${ADDRESS_A}.sealedquote`)).toBeNull();
    } finally {
      console.warn = original;
    }
  });

  it('stores and retrieves a signing key', async () => {
    const provider = browserPrivateStateProvider();
    await provider.setSigningKey(ADDRESS_A as any, 'signing-key-value' as any);
    expect(await provider.getSigningKey(ADDRESS_A as any)).toBe('signing-key-value');
  });

  it('does not require a contract address for signing key access', async () => {
    // Signing keys take the address as an argument, so no scoping call needed.
    const provider = browserPrivateStateProvider();
    await expect(provider.getSigningKey(ADDRESS_A as any)).resolves.toBeNull();
  });

  it('clear() removes private states but leaves signing keys', async () => {
    const provider = browserPrivateStateProvider();
    provider.setContractAddress(ADDRESS_A as any);
    await provider.set('sealedquote', { lastBid: 1n });
    await provider.setSigningKey(ADDRESS_A as any, 'keep-me' as any);

    await provider.clear();

    expect(await provider.get('sealedquote')).toBeNull();
    expect(await provider.getSigningKey(ADDRESS_A as any)).toBe('keep-me');
  });

  it('clearSigningKeys() removes signing keys but leaves private states', async () => {
    const provider = browserPrivateStateProvider();
    provider.setContractAddress(ADDRESS_A as any);
    await provider.set('sealedquote', { lastBid: 42n });
    await provider.setSigningKey(ADDRESS_A as any, 'drop-me' as any);

    await provider.clearSigningKeys();

    expect(await provider.getSigningKey(ADDRESS_A as any)).toBeNull();
    expect(((await provider.get('sealedquote')) as SealedQuotePrivateState).lastBid).toBe(42n);
  });

  it('reports encrypted export/import as unsupported rather than failing silently', async () => {
    const provider = browserPrivateStateProvider();
    await expect(provider.exportPrivateStates()).rejects.toThrow(/not supported/);
    await expect(provider.exportSigningKeys()).rejects.toThrow(/not supported/);
  });
});

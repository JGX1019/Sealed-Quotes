/**
 * useMidnight.ts — React hook wrapping the Lace wallet's DApp Connector API.
 *
 * Handles:
 *  - Detecting window.midnight (Lace injects itself here, may take a moment)
 *  - Connect / disconnect flow
 *  - Surfacing connection errors (wallet not installed, user rejected, network mismatch)
 *  - Exposing the connected wallet's unshielded address for display
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectedAPI, InitialAPI } from '@midnight-ntwrk/dapp-connector-api';

export type WalletStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

// The Preprod network id string expected by the wallet's connect() call.
const EXPECTED_NETWORK_ID = 'preprod';

export interface UseMidnightResult {
  status: WalletStatus;
  address: string | null;
  error: string | null;
  connectedAPI: ConnectedAPI | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

/** Polls for window.midnight for a short window — Lace can take a moment to inject. */
function waitForWalletInjection(timeoutMs = 3000): Promise<Record<string, InitialAPI> | null> {
  return new Promise((resolve) => {
    if (window.midnight) {
      resolve(window.midnight);
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      if (window.midnight) {
        clearInterval(interval);
        resolve(window.midnight);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve(null);
      }
    }, 150);
  });
}

export function useMidnight(): UseMidnightResult {
  const [status, setStatus] = useState<WalletStatus>('disconnected');
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connectedAPIRef = useRef<ConnectedAPI | null>(null);

  const disconnect = useCallback(() => {
    connectedAPIRef.current = null;
    setStatus('disconnected');
    setAddress(null);
    setError(null);
  }, []);

  const connect = useCallback(async () => {
    setStatus('connecting');
    setError(null);

    const midnightApis = await waitForWalletInjection();
    if (!midnightApis) {
      setStatus('error');
      setError('No Midnight-compatible wallet found. Install a Midnight wallet extension (such as Lace) and reload.');
      return;
    }

    // Prefer Lace if present under its known key, otherwise take the first injected wallet
    // — any wallet implementing the Midnight DApp Connector API works here.
    const initialAPI = midnightApis.mnLace ?? Object.values(midnightApis)[0];
    if (!initialAPI) {
      setStatus('error');
      setError('No Midnight-compatible wallet found. Install a Midnight wallet extension (such as Lace) and reload.');
      return;
    }

    try {
      const connectedAPI = await initialAPI.connect(EXPECTED_NETWORK_ID);
      const config = await connectedAPI.getConfiguration();

      if (config.networkId !== EXPECTED_NETWORK_ID) {
        setStatus('error');
        setError(
          `Wallet is connected to "${config.networkId}", but this dApp expects "${EXPECTED_NETWORK_ID}". Switch your wallet's network and try again.`,
        );
        return;
      }

      const { unshieldedAddress } = await connectedAPI.getUnshieldedAddress();

      connectedAPIRef.current = connectedAPI;
      setAddress(unshieldedAddress);
      setStatus('connected');
    } catch (e: any) {
      setStatus('error');
      if (e?.code === 'Rejected' || e?.type === 'DAppConnectorAPIError') {
        setError(e.reason ?? 'Connection request was rejected.');
      } else {
        setError(e?.message ?? 'Failed to connect to wallet.');
      }
    }
  }, []);

  // If the wallet disconnects externally (e.g. user locks it), reflect that in state.
  useEffect(() => {
    if (status !== 'connected' || !connectedAPIRef.current) return;
    let cancelled = false;
    const api = connectedAPIRef.current;

    const poll = setInterval(async () => {
      try {
        const connStatus = await api.getConnectionStatus();
        if (!cancelled && connStatus.status === 'disconnected') {
          disconnect();
        }
      } catch {
        if (!cancelled) disconnect();
      }
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [status, disconnect]);

  return {
    status,
    address,
    error,
    connectedAPI: connectedAPIRef.current,
    connect,
    disconnect,
  };
}

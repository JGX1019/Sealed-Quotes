/**
 * WalletConnect.tsx — connect/disconnect UI for any Midnight-compatible wallet.
 *
 * Shows:
 *  - a Connect button when disconnected
 *  - a spinner state while connecting
 *  - the connected wallet's unshielded address, plus a Disconnect button
 *  - a clear error message for: wallet not installed, user rejected, network mismatch
 */
import type { UseMidnightResult } from '../hooks/useMidnight';

function truncateAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 10)}...${address.slice(-6)}`;
}

export function WalletConnect({ status, address, error, connect, disconnect }: UseMidnightResult) {
  return (
    <div className="wallet-connect">
      {status === 'disconnected' && (
        <button onClick={connect} className="btn btn-primary">
          Connect Wallet
        </button>
      )}

      {status === 'connecting' && (
        <button className="btn btn-primary" disabled>
          <span className="spinner" aria-hidden="true" /> Connecting
        </button>
      )}

      {status === 'connected' && address && (
        <div className="wallet-connected">
          <span className="wallet-address" title={address}>
            {truncateAddress(address)}
          </span>
          <button onClick={disconnect} className="btn btn-secondary">
            Disconnect
          </button>
        </div>
      )}

      {status === 'error' && (
        <div className="wallet-error">
          <p role="alert">{error}</p>
          <button onClick={connect} className="btn btn-primary">
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

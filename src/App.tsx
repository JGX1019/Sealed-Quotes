import { useMidnight } from './hooks/useMidnight';
import { WalletConnect } from './components/WalletConnect';
import { RfqCard } from './components/RfqCard';
import './styles.css';

export function App() {
  const midnight = useMidnight();

  return (
    <>
      <header className="topbar">
        <h1 className="brand">
          <span className="brand-mark" aria-hidden="true">◔</span>
          SealedQuote
        </h1>

        <div className="topbar-meta">
          {midnight.status === 'connected' && (
            <span className="net-name">
              Preprod <span className="wallet-status-dot" aria-hidden="true" /> Connected
            </span>
          )}
          <WalletConnect {...midnight} />
        </div>
      </header>

      <div className="page">
        <div className="intro">
          <p>
            A private RFQ marketplace. Buyers publish a budget; suppliers submit sealed bids proven against it
            entirely in zero knowledge. Anyone can see how many bids qualified — nobody, not the buyer, not rival
            suppliers, sees a single price.
          </p>
        </div>

        {midnight.status === 'connected' && midnight.connectedAPI ? (
          <RfqCard connectedAPI={midnight.connectedAPI} />
        ) : (
          <p className="hint">Connect any Midnight-compatible wallet to post an RFQ or submit a sealed bid.</p>
        )}

        <footer className="page-footer">
          <p>
            Built on Midnight. Bid prices are private circuit inputs — only the bid and qualifying counters are
            written on-chain.
          </p>
        </footer>
      </div>
    </>
  );
}

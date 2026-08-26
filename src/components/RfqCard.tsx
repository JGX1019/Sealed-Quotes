/**
 * RfqCard.tsx — deploy/join a SealedQuote RFQ, run it as a buyer (open a
 * budget, watch qualifying bids, close it), or bid on it as a supplier.
 *
 * The price a supplier types in is a PRIVATE circuit input. It is used
 * only to generate the proof locally in the browser, and is deliberately
 * cleared from component state right after submission so it is never
 * rendered back to the user, never logged, and never included in any
 * result view — only the public bid/qualifying counters change.
 */
import { useState } from 'react';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { closeRfq, deployRfq, joinRfq, openRfq, readRfqState, submitBid, type RfqState } from '../api/contract';

type TxStatus = 'idle' | 'deploying' | 'joining' | 'proving' | 'confirmed' | 'failed';

interface Props {
  connectedAPI: ConnectedAPI;
}

/** Maps raw SDK/wallet errors onto messages a participant can act on. */
function friendlyError(e: any): string {
  const raw = String(e?.message ?? e ?? 'Unknown error');
  if (/not enough dust/i.test(raw)) {
    return 'Not enough tDUST to pay the transaction fee. Open your wallet, generate tDUST, then try again.';
  }
  if (/rejected/i.test(raw)) return 'Request was rejected in your wallet.';
  if (/timed out/i.test(raw)) {
    return `${raw}. The transaction may still land on-chain — refresh the state in a moment to check.`;
  }
  if (/proof server|proving/i.test(raw)) {
    return 'Proof generation failed. Check that your wallet is pointed at a running local proof server (http://127.0.0.1:6300).';
  }
  if (/failed to fetch|networkerror/i.test(raw)) {
    return 'Network request failed. Check your connection and that the indexer is reachable, then retry.';
  }
  if (/rfq is not open/i.test(raw)) return 'This RFQ is not accepting bids right now.';
  if (/rfq is already closed/i.test(raw)) return 'This RFQ is already closed.';
  if (/budget must be positive|price must be positive/i.test(raw)) return raw;
  return raw;
}

function qualifyRate(s: RfqState): string {
  if (s.bidCount === 0n) return '—';
  return `${((Number(s.qualifyingCount) / Number(s.bidCount)) * 100).toFixed(0)}%`;
}

export function RfqCard({ connectedAPI }: Props) {
  const [contractAddress, setContractAddress] = useState<string | null>(null);
  const [addressInput, setAddressInput] = useState('');
  const [deployedContract, setDeployedContract] = useState<any>(null);
  const [rfq, setRfq] = useState<RfqState | null>(null);

  const [budgetInput, setBudgetInput] = useState('1000');
  const [priceInput, setPriceInput] = useState('');

  const [txStatus, setTxStatus] = useState<TxStatus>('idle');
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [txId, setTxId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const busy = txStatus === 'deploying' || txStatus === 'joining' || txStatus === 'proving';

  const refresh = async (address: string) => {
    try {
      setRfq(await readRfqState(connectedAPI, address));
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const handleDeploy = async () => {
    setError(null);
    setTxStatus('deploying');
    try {
      const contract = await deployRfq(connectedAPI);
      const address = contract.deployTxData.public.contractAddress;
      setDeployedContract(contract);
      setContractAddress(address);
      setRfq({ budgetMax: 0n, bidCount: 0n, qualifyingCount: 0n, isOpen: false });
      setTxStatus('idle');
    } catch (e) {
      setTxStatus('failed');
      setError(friendlyError(e));
    }
  };

  const handleJoin = async () => {
    const address = addressInput.trim();
    if (!address) {
      setError('Enter a contract address to join.');
      return;
    }
    setError(null);
    setTxStatus('joining');
    try {
      const contract = await joinRfq(connectedAPI, address);
      setDeployedContract(contract);
      setContractAddress(address);
      await refresh(address);
      setTxStatus('idle');
    } catch (e) {
      setTxStatus('failed');
      setError(friendlyError(e));
    }
  };

  const handleOpen = async () => {
    if (!deployedContract) return;
    const budget = BigInt(budgetInput || '0');
    if (budget <= 0n) {
      setError('Budget must be a positive number.');
      return;
    }
    setError(null);
    setTxStatus('proving');
    setLastAction('open');
    setTxId(null);
    try {
      const result = await openRfq(deployedContract, budget);
      setTxId(result.txId);
      setTxStatus('confirmed');
      if (contractAddress) await refresh(contractAddress);
    } catch (e) {
      setTxStatus('failed');
      setError(friendlyError(e));
    }
  };

  const handleBid = async () => {
    if (!deployedContract) return;
    const price = BigInt(priceInput || '0');
    if (price <= 0n) {
      setError('Enter a bid price greater than zero.');
      return;
    }
    setError(null);
    setTxStatus('proving');
    setLastAction('bid');
    setTxId(null);
    try {
      const result = await submitBid(deployedContract, price);
      setTxId(result.txId);
      setTxStatus('confirmed');
      // Clear the private price immediately — it has served its purpose as
      // a proof input and must not linger in UI state.
      setPriceInput('');
      if (contractAddress) await refresh(contractAddress);
    } catch (e) {
      setTxStatus('failed');
      setError(friendlyError(e));
    }
  };

  const handleClose = async () => {
    if (!deployedContract) return;
    setError(null);
    setTxStatus('proving');
    setLastAction('close');
    setTxId(null);
    try {
      const result = await closeRfq(deployedContract);
      setTxId(result.txId);
      setTxStatus('confirmed');
      if (contractAddress) await refresh(contractAddress);
    } catch (e) {
      setTxStatus('failed');
      setError(friendlyError(e));
    }
  };

  if (!deployedContract) {
    return (
      <section className="section">
        <div className="section-head">
          <h2>RFQ</h2>
        </div>

        <button onClick={handleDeploy} disabled={busy} className="btn btn-primary btn-block">
          {txStatus === 'deploying' ? (
            <>
              <span className="spinner" aria-hidden="true" /> Deploying RFQ
            </>
          ) : (
            'Post New RFQ (Buyer)'
          )}
        </button>

        <div className="join-row">
          <label htmlFor="contract-address">Or join an existing RFQ (as buyer or supplier)</label>
          <div className="join-inputs">
            <input
              id="contract-address"
              type="text"
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
              placeholder="Contract address (hex)"
              className="input"
              autoComplete="off"
              spellCheck={false}
            />
            <button onClick={handleJoin} disabled={busy} className="btn btn-secondary">
              {txStatus === 'joining' ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Joining
                </>
              ) : (
                'Join'
              )}
            </button>
          </div>
        </div>

        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
      </section>
    );
  }

  return (
    <>
      <div className="stats">
        <div className="stat">
          <span className="label">Budget</span>
          <p className="stat-value">{rfq && rfq.budgetMax > 0n ? rfq.budgetMax.toString() : '—'}</p>
          <p className="stat-note">Buyer's published ceiling</p>
        </div>
        <div className="stat">
          <span className="label">Bids</span>
          <p className="stat-value">{rfq ? rfq.bidCount.toString() : '—'}</p>
          <p className="stat-note">Sealed bids submitted</p>
        </div>
        <div className="stat">
          <span className="label">Qualifying</span>
          <p className="stat-value">{rfq ? `${rfq.qualifyingCount.toString()}` : '—'}</p>
          <p className="stat-note">{rfq ? `${qualifyRate(rfq)} at or under budget` : 'At or under budget'}</p>
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>{rfq?.isOpen ? 'Open for bids' : rfq && rfq.budgetMax > 0n ? 'Closed' : 'Not opened yet'}</h2>
          <span className={`badge ${rfq?.isOpen ? '' : 'badge-muted'}`}>
            {rfq?.isOpen ? 'Open' : rfq && rfq.budgetMax > 0n ? 'Closed' : 'Draft'}
          </span>
        </div>

        <dl className="meta">
          <dt>Contract</dt>
          <dd className="mono break" title={contractAddress ?? ''}>
            {contractAddress}
          </dd>
        </dl>

        {(!rfq || rfq.budgetMax === 0n) && (
          <div className="rfq-panel">
            <label htmlFor="budget-input" className="label">
              Buyer: set budget ceiling &amp; open for bids
            </label>
            <div className="join-inputs" style={{ marginTop: '0.5rem' }}>
              <input
                id="budget-input"
                type="number"
                min="1"
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
                className="input"
              />
              <button onClick={handleOpen} disabled={busy} className="btn btn-primary">
                {txStatus === 'proving' && lastAction === 'open' ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Opening
                  </>
                ) : (
                  'Open RFQ'
                )}
              </button>
            </div>
          </div>
        )}

        {rfq && rfq.budgetMax > 0n && rfq.isOpen && (
          <div className="rfq-panel">
            <label htmlFor="price-input" className="label">
              Supplier: submit a sealed bid
            </label>
            <div className="join-inputs" style={{ marginTop: '0.5rem' }}>
              <input
                id="price-input"
                type="number"
                min="1"
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                placeholder="Your price"
                className="input"
              />
              <button onClick={handleBid} disabled={busy || !priceInput} className="btn btn-primary">
                {txStatus === 'proving' && lastAction === 'bid' ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Proving
                  </>
                ) : (
                  'Submit Sealed Bid'
                )}
              </button>
            </div>
            <p className="privacy-label">
              Your price stays private — it never leaves your browser. Only whether you qualified is disclosed,
              never the amount.
            </p>
          </div>
        )}

        <div className="actions">
          <div className="actions-row">
            <button onClick={() => contractAddress && refresh(contractAddress)} disabled={busy} className="btn btn-secondary">
              Refresh
            </button>
            {rfq?.isOpen && (
              <button onClick={handleClose} disabled={busy} className="btn btn-secondary">
                {txStatus === 'proving' && lastAction === 'close' ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Closing
                  </>
                ) : (
                  'Close RFQ (Buyer)'
                )}
              </button>
            )}
          </div>
        </div>

        {txStatus === 'proving' && lastAction === 'bid' && (
          <div className="status status-working" role="status">
            <p>
              Building a zero-knowledge proof in your browser. This proves your price is at or under the buyer's
              budget without revealing what it was.
            </p>
          </div>
        )}

        {txStatus === 'confirmed' && txId && (
          <div className="status status-ok" role="status">
            <span className="badge">Confirmed</span>
            <p>Transaction recorded on-chain.</p>
            <p className="mono break tx-id" title={txId}>
              tx: {txId}
            </p>
          </div>
        )}

        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
      </section>
    </>
  );
}

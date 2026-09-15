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
import { useEffect, useState } from 'react';
import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import {
  closeRfq,
  deployRfq,
  hasPreviousBid,
  joinRfq,
  openRfq,
  readRfqState,
  submitBid,
  submitRevisedBid,
  type RfqState,
} from '../api/contract';

type TxStatus = 'idle' | 'deploying' | 'joining' | 'proving' | 'confirmed' | 'failed';
type LastAction = 'open' | 'bid' | 'revise' | 'close';

/**
 * The RFQ this deployment ships pointed at by default, so a visitor never has
 * to know or paste a contract address to try the app — they land straight on
 * a live RFQ. Deployed to Preprod; verified on-chain via the public indexer.
 *
 * "Post New RFQ" still deploys a fresh contract and switches to it, and the
 * join field still accepts any other address, so this default doesn't limit
 * what the app can do — it only removes the friction of a blank first
 * screen.
 */
const DEFAULT_CONTRACT_ADDRESS = '56e3132cde0d680024483bd073c055e1e0c88789b9f0011f759c50c991044490';

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
  // The revision circuit's two asserts, translated. Note neither message can
  // echo the amounts involved — they're private, and the UI never learns them.
  if (/strictly lower/i.test(raw)) {
    return 'A revised bid must be strictly lower than your previous bid on this RFQ. The proof was rejected, so nothing was submitted.';
  }
  if (/no earlier bid/i.test(raw)) {
    return 'No earlier bid found in this browser for this RFQ. Submit a first sealed bid before revising.';
  }
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
  const [revisedPriceInput, setRevisedPriceInput] = useState('');

  /**
   * Whether this browser holds a remembered previous bid for this RFQ in
   * private state. Deliberately a boolean and not the amount: showing the
   * remembered price would undo the whole point of proving an improvement
   * without disclosing either number.
   */
  const [hasPrevious, setHasPrevious] = useState(false);

  const [txStatus, setTxStatus] = useState<TxStatus>('idle');
  const [lastAction, setLastAction] = useState<LastAction | null>(null);
  const [txId, setTxId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tracks the background auto-load of DEFAULT_CONTRACT_ADDRESS separately
  // from txStatus, so a failed silent join doesn't leave `busy` stuck true
  // and doesn't surface as a user-facing error (see joinAddress's `silent`
  // option) — it only gates the loading message on the initial screen.
  const [autoLoading, setAutoLoading] = useState(true);

  const busy = txStatus === 'deploying' || txStatus === 'joining' || txStatus === 'proving';

  const refresh = async (address: string) => {
    try {
      setRfq(await readRfqState(connectedAPI, address));
      setHasPrevious(await hasPreviousBid(connectedAPI, address));
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
      setRfq({ budgetMax: 0n, bidCount: 0n, qualifyingCount: 0n, revisionCount: 0n, isOpen: false });
      // A freshly deployed RFQ can't have a remembered bid yet.
      setHasPrevious(false);
      setTxStatus('idle');
    } catch (e) {
      setTxStatus('failed');
      setError(friendlyError(e));
    }
  };

  /**
   * Joins the RFQ at `address`. Shared by the manual "Join" button and the
   * auto-load effect below — `silent` suppresses the join spinner/errors for
   * the automatic case, since a background attempt to load the default RFQ
   * failing should not block someone who is about to paste in their own
   * address anyway.
   */
  const joinAddress = async (address: string, options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setError(null);
      setTxStatus('joining');
    }
    try {
      const contract = await joinRfq(connectedAPI, address);
      setDeployedContract(contract);
      setContractAddress(address);
      await refresh(address);
      if (!options.silent) setTxStatus('idle');
    } catch (e) {
      if (options.silent) {
        console.warn(`Could not auto-load the default RFQ (${address}):`, e);
      } else {
        setTxStatus('failed');
        setError(friendlyError(e));
      }
    } finally {
      if (options.silent) setAutoLoading(false);
    }
  };

  const handleJoin = async () => {
    const address = addressInput.trim();
    if (!address) {
      setError('Enter a contract address to join.');
      return;
    }
    await joinAddress(address);
  };

  // Auto-load the default RFQ as soon as the wallet connects, so a visitor
  // lands on a live RFQ instead of a blank "post or join" screen. Runs once
  // per connection; posting a new RFQ or joining a different one afterwards
  // simply replaces `deployedContract`, so this never fights a manual action.
  useEffect(() => {
    setAddressInput(DEFAULT_CONTRACT_ADDRESS);
    void joinAddress(DEFAULT_CONTRACT_ADDRESS, { silent: true });
    // connectedAPI changes when the wallet (re)connects — re-attempt the
    // auto-load in that case, but not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedAPI]);

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

  const handleRevisedBid = async () => {
    if (!deployedContract) return;
    const price = BigInt(revisedPriceInput || '0');
    if (price <= 0n) {
      setError('Enter a revised bid price greater than zero.');
      return;
    }
    setError(null);
    setTxStatus('proving');
    setLastAction('revise');
    setTxId(null);
    try {
      const result = await submitRevisedBid(deployedContract, price);
      setTxId(result.txId);
      setTxStatus('confirmed');
      // Same reasoning as handleBid: the revised price was only ever a proof
      // input, so drop it from UI state as soon as the proof is built.
      setRevisedPriceInput('');
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

        {autoLoading && (
          <p className="hint">
            <span className="spinner" aria-hidden="true" /> Loading the default RFQ…
          </p>
        )}

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
        <div className="stat">
          <span className="label">Revisions</span>
          <p className="stat-value">{rfq ? rfq.revisionCount.toString() : '—'}</p>
          <p className="stat-note">Proven price improvements</p>
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
          <dt>Your private state</dt>
          <dd>
            {hasPrevious ? (
              <>
                Previous bid remembered on this device
                <span className="privacy-label"> (amount never shown, never sent on-chain)</span>
              </>
            ) : (
              'No bid remembered on this device yet'
            )}
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

        {rfq && rfq.budgetMax > 0n && rfq.isOpen && hasPrevious && (
          <div className="rfq-panel">
            <label htmlFor="revised-price-input" className="label">
              Supplier: revise your bid downward
            </label>
            <div className="join-inputs" style={{ marginTop: '0.5rem' }}>
              <input
                id="revised-price-input"
                type="number"
                min="1"
                value={revisedPriceInput}
                onChange={(e) => setRevisedPriceInput(e.target.value)}
                placeholder="Your new, lower price"
                className="input"
              />
              <button
                onClick={handleRevisedBid}
                disabled={busy || !revisedPriceInput}
                className="btn btn-primary"
              >
                {txStatus === 'proving' && lastAction === 'revise' ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Proving
                  </>
                ) : (
                  'Submit Revised Bid'
                )}
              </button>
            </div>
            <p className="privacy-label">
              This browser remembers your last bid in <strong>private state</strong> — on your device only, never
              on-chain. The proof shows your new bid is strictly lower than it, without revealing either number.
              The ledger records only that a verified improvement happened.
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

        {txStatus === 'proving' && lastAction === 'revise' && (
          <div className="status status-working" role="status">
            <p>
              Building a zero-knowledge proof in your browser. Both numbers being compared are private — your new
              bid, and the previous one read from your local private state. The proof establishes that the new bid
              is lower without disclosing either.
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

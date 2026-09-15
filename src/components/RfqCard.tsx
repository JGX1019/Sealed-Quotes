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
  isBuyer,
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
 *
 * Empty for now: the previous default (56e3132c...) was deployed against an
 * older circuit shape — `open_rfq(budget, unit)` with no title, no
 * `buyer_key`, no `is_initialized` — before the bug-fix round that added the
 * title field, the buyer-identity checks, and the one-bid-then-revise-only
 * guard. That old contract's bytecode never gained those fields, so pointing
 * this constant at it would make `readRfqState` decode a `title`/`buyer_key`
 * that doesn't exist on-chain and fail. Deploy a fresh RFQ via "Post New RFQ"
 * and set this to the new address.
 */
const DEFAULT_CONTRACT_ADDRESS = '';

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
  if (/the buyer cannot bid/i.test(raw)) {
    return 'The wallet that opened this RFQ cannot also bid on it.';
  }
  if (/already have a bid/i.test(raw)) {
    return "You've already submitted a bid on this RFQ. Use \"Submit Revised Bid\" to lower it.";
  }
  if (/already been opened/i.test(raw)) {
    return 'This RFQ has already been opened and its terms cannot be changed.';
  }
  if (/only the buyer.*may close/i.test(raw)) {
    return 'Only the wallet that opened this RFQ can close it.';
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

  const [titleInput, setTitleInput] = useState('');
  const [budgetInput, setBudgetInput] = useState('1000');
  const [unitInput, setUnitInput] = useState('USD');
  const [priceInput, setPriceInput] = useState('');
  const [revisedPriceInput, setRevisedPriceInput] = useState('');

  /**
   * Whether this browser holds a remembered previous bid for this RFQ in
   * private state. Deliberately a boolean and not the amount: showing the
   * remembered price would undo the whole point of proving an improvement
   * without disclosing either number.
   */
  const [hasPrevious, setHasPrevious] = useState(false);

  /**
   * Whether the connected wallet is the buyer who opened this RFQ. Drives
   * which panels the UI offers — the buyer sees no bid/revise forms (the
   * contract would reject both from them), everyone else doesn't see the
   * buyer's open form once it's already open, and only the buyer sees
   * "Close RFQ". This mirrors, but does not replace, the contract's own
   * ownPublicKey() checks — see isBuyer's docstring in api/contract.ts.
   */
  const [amBuyer, setAmBuyer] = useState(false);

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
      const state = await readRfqState(connectedAPI, address);
      setRfq(state);
      setHasPrevious(await hasPreviousBid(connectedAPI, address));
      setAmBuyer(state?.isInitialized ? await isBuyer(connectedAPI, state.buyerKeyHex) : false);
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
      setRfq({
        title: '',
        budgetMax: 0n,
        unitLabel: '',
        bidCount: 0n,
        qualifyingCount: 0n,
        revisionCount: 0n,
        isInitialized: false,
        isOpen: false,
        buyerKeyHex: '',
      });
      // A freshly deployed RFQ can't have a remembered bid yet, and whoever
      // deploys it is the buyer by definition — open_rfq hasn't run yet, but
      // this browser is the only one that can run it (the buyer form only
      // renders pre-open, and after open the deployer's key becomes buyer_key).
      setHasPrevious(false);
      setAmBuyer(true);
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
    if (!DEFAULT_CONTRACT_ADDRESS) {
      // No default configured — go straight to the post/join screen instead
      // of trying to join an empty address.
      setAutoLoading(false);
      return;
    }
    setAddressInput(DEFAULT_CONTRACT_ADDRESS);
    void joinAddress(DEFAULT_CONTRACT_ADDRESS, { silent: true });
    // connectedAPI changes when the wallet (re)connects — re-attempt the
    // auto-load in that case, but not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedAPI]);

  const handleOpen = async () => {
    if (!deployedContract) return;
    const title = titleInput.trim();
    if (!title) {
      setError('Enter what this budget is for (e.g. "40 office chairs").');
      return;
    }
    const budget = BigInt(budgetInput || '0');
    if (budget <= 0n) {
      setError('Budget must be a positive number.');
      return;
    }
    const unit = unitInput.trim();
    if (!unit) {
      setError('Enter a unit for the budget (e.g. USD, USDC, tDUST).');
      return;
    }
    setError(null);
    setTxStatus('proving');
    setLastAction('open');
    setTxId(null);
    try {
      const result = await openRfq(deployedContract, title, budget, unit);
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

  // The buyer's open form and a supplier's bid/revise forms are mutually
  // exclusive. amBuyer only means anything once rfq.isInitialized (before
  // that, "buyer" hasn't been decided by the contract yet — see handleOpen).
  const isBuyerHere = rfq?.isInitialized === true && amBuyer;
  const isSupplierHere = rfq?.isInitialized === true && !amBuyer;

  return (
    <>
      <div className="stats">
        <div className="stat">
          <span className="label">Budget</span>
          <p className="stat-value">
            {rfq && rfq.isInitialized ? rfq.budgetMax.toString() : '—'}
            {rfq && rfq.isInitialized && rfq.unitLabel && <span className="stat-unit"> {rfq.unitLabel}</span>}
          </p>
          <p className="stat-note">
            {rfq && rfq.isInitialized ? (
              <>
                For: <strong>{rfq.title || '(untitled)'}</strong> — unit is display-only, not enforced by the
                contract
              </>
            ) : (
              "Buyer's published ceiling"
            )}
          </p>
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
          <h2>{rfq?.isOpen ? 'Open for bids' : rfq?.isInitialized ? 'Closed' : 'Not opened yet'}</h2>
          <span className={`badge ${rfq?.isOpen ? '' : 'badge-muted'}`}>
            {rfq?.isOpen ? 'Open' : rfq?.isInitialized ? 'Closed' : 'Draft'}
          </span>
        </div>

        <dl className="meta">
          <dt>Contract</dt>
          <dd className="mono break" title={contractAddress ?? ''}>
            {contractAddress}
          </dd>
          <dt>Your role</dt>
          <dd>
            {!rfq?.isInitialized
              ? 'Not yet decided — whoever opens this RFQ becomes its buyer'
              : isBuyerHere
                ? 'Buyer — you opened this RFQ, so you cannot bid on it'
                : 'Supplier — you may submit or revise a sealed bid'}
          </dd>
          {isSupplierHere && (
            <>
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
            </>
          )}
        </dl>

        {!rfq?.isInitialized && (
          <div className="rfq-panel">
            <label htmlFor="title-input" className="label">
              Buyer: name what this budget is for &amp; open for bids
            </label>
            <div className="join-inputs" style={{ marginTop: '0.5rem' }}>
              <input
                id="title-input"
                type="text"
                maxLength={32}
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                placeholder="e.g. 40 office chairs"
                className="input"
                aria-label="RFQ title"
              />
            </div>
            <div className="join-inputs" style={{ marginTop: '0.5rem' }}>
              <input
                id="budget-input"
                type="number"
                min="1"
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
                className="input"
                aria-label="Budget amount"
              />
              <input
                id="unit-input"
                type="text"
                maxLength={16}
                value={unitInput}
                onChange={(e) => setUnitInput(e.target.value)}
                placeholder="Unit (USD, tDUST, ...)"
                className="input"
                aria-label="Budget unit"
                style={{ maxWidth: '9rem' }}
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
            <p className="privacy-label">
              The title and unit are labels for humans, not cryptographic guarantees — the contract only compares
              numbers, it does not move, hold, or verify any currency. Once opened, these terms are locked: this
              RFQ can never be reopened to change them. Suppliers should confirm the unit with you off-chain
              before bidding.
            </p>
          </div>
        )}

        {isSupplierHere && rfq.isOpen && !hasPrevious && (
          <div className="rfq-panel">
            <label htmlFor="price-input" className="label">
              Supplier: submit a sealed bid{rfq.unitLabel && ` (in ${rfq.unitLabel})`}
            </label>
            <div className="join-inputs" style={{ marginTop: '0.5rem' }}>
              <input
                id="price-input"
                type="number"
                min="1"
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                placeholder={rfq.unitLabel ? `Your price, in ${rfq.unitLabel}` : 'Your price'}
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
              never the amount. You get one bid; after this, further changes must go through "revise downward".
            </p>
          </div>
        )}

        {isSupplierHere && rfq.isOpen && hasPrevious && (
          <div className="rfq-panel">
            <label htmlFor="revised-price-input" className="label">
              Supplier: revise your bid downward{rfq.unitLabel && ` (in ${rfq.unitLabel})`}
            </label>
            <div className="join-inputs" style={{ marginTop: '0.5rem' }}>
              <input
                id="revised-price-input"
                type="number"
                min="1"
                value={revisedPriceInput}
                onChange={(e) => setRevisedPriceInput(e.target.value)}
                placeholder={rfq.unitLabel ? `Your new, lower price, in ${rfq.unitLabel}` : 'Your new, lower price'}
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
            {rfq?.isOpen && isBuyerHere && (
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

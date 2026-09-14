# SealedQuote

![CI](https://github.com/JGX1019/Sealed-Quotes/actions/workflows/ci.yml/badge.svg)

> A private RFQ marketplace on Midnight — sealed bids, publicly verifiable qualification, no revealed price.

## Live Demo

[PASTE LIVE URL AFTER DEPLOYING FRONTEND]

## Contract Address

| Network | Address |
|---------|---------|
| Preprod | `77c68b3e318b86b97a0d9c980d3df9343b11326c5a9d40ee9324be76dee3fdc7` |

## What This Does

A buyer posts a request-for-quote with a public budget ceiling. Suppliers submit sealed bids: each price is checked against the budget entirely inside a zero-knowledge proof generated in the supplier's browser, so the exact price never touches the chain, never reaches the buyer, and is never visible to rival suppliers. The only public facts are how many bids came in and how many of those bids were at or under budget.

Suppliers can also **revise a bid downward**. The contract proves the new bid is strictly lower than that supplier's own previous bid — comparing two numbers that are both private, one a fresh circuit input and one read back from the supplier's local private state. The buyer gets cryptographic proof that a "best and final offer" round genuinely improved, without learning either price or the size of the cut.

This is aimed at B2B procurement, where sealed bidding is the norm but rarely actually sealed — suppliers routinely bid conservatively because they suspect a competitor can infer their price from a leak. SealedQuote makes "sealed" a cryptographic property instead of a promise.

**Honest scope note:** this build does not pick or settle a winner on-chain — trustlessly comparing every sealed bid against every *other supplier's* bid to find the lowest is an argmin circuit over private values, which didn't fit the timeline. The per-supplier comparison in `submit_revised_bid` is the single-supplier case of that same problem, solved. See [PROPOSAL.md](./PROPOSAL.md) for what a production version adds.

## Privacy Model

SealedQuote uses both halves of Midnight's dual ledger: a public on-chain ledger, and a per-supplier private state that lives only on the supplier's own device.

- **PUBLIC (on-chain ledger):** `budget_max` (the buyer's disclosed ceiling), `bid_count` (total sealed bids), `qualifying_count` (bids at or under budget), `revision_count` (proven price improvements), and `is_open` (whether the RFQ still accepts bids).
- **PRIVATE STATE (persisted locally, never on-chain):** `lastBid` — the price this supplier most recently bid on this RFQ. Written by the `remember_bid` witness, read back by the `local_last_bid` witness. It exists so a revision can be proven against it, and it is never serialised into a transaction. The UI never displays it either — it only shows whether *some* previous bid exists.
- **PRIVATE CIRCUIT INPUT (transient):** `price` — the exact bid being submitted right now. Consumed inside the ZK proof and discarded; never stored anywhere.
- **PROVED without revealing:**
  - that the price is a well-formed, positive bid;
  - that it is at or under the buyer's published budget — disclosing only the boolean fact that it qualified;
  - and for a revision, that the new price is *strictly lower than the supplier's own previous price* — where **both** numbers are private, so the proof establishes a relationship between two values nobody else ever sees.

### Where each piece of state lives

| State | Lives on | Written by | Readable by |
|-------|----------|-----------|-------------|
| `budget_max`, `bid_count`, `qualifying_count`, `revision_count`, `is_open` | Public ledger | Circuits, via `disclose()` | Anyone |
| `lastBid` | Supplier's browser (private state provider) | `remember_bid` witness | Only that supplier's device |
| `price` | Nowhere — exists only inside the proof | n/a | No one |

## Privacy Claim

**What an on-chain observer can learn:** the contract address; the buyer's published budget; the total number of bids; how many of them qualified; how many were proven improvements on an earlier bid; whether the RFQ is still open; and, for each transaction, which wallet submitted it, whether that specific bid qualified, and whether it was a revision.

**What an on-chain observer cannot learn:** the exact price of any bid, by anyone, at any time. A $10 bid and a $9,999 bid that both qualify are indistinguishable on the ledger; so are two different over-budget bids. For revisions, neither the old price, the new price, nor the *difference between them* is disclosed — a supplier shaving 1 off their bid and a supplier halving it produce byte-identical public state. No transcript, ledger field, or proof artifact contains a price, and there's no on-chain record linking a wallet to an amount.

**Honest limitations**, stated plainly:

1. **One bit per bid.** Because `qualifying_count` updates once per bid transaction, an observer watching individual transactions learns whether that bid qualified. The exact price stays hidden, but that single bit is disclosed by design — publishing a verifiable qualification rate is the point of the product.
2. **One bit per revision.** Likewise, `revision_count` reveals that a supplier improved their own bid. The magnitude is not disclosed, but the fact of the improvement is.
3. **Private state is stored unencrypted in `localStorage`.** It never leaves the device, so the buyer, rival suppliers, and chain observers cannot read it — which is the threat model this product cares about. It is *not* protected against someone who already controls the supplier's machine or another script on the same origin. A production deployment should use the wallet's own encrypted private state storage instead; see [PROPOSAL.md](./PROPOSAL.md).
4. **No on-chain winner selection.** Selecting and settling a specific winning price across suppliers is out of scope for this build — see [PROPOSAL.md](./PROPOSAL.md), "Mainnet Feasibility."

## Architecture

### Contract

`contracts/sealedquote.compact` declares five public ledger fields, two witnesses, and four circuits:

| Circuit | Private input | Reads private state | Public effect |
|---------|--------------|---------------------|---------------|
| `open_rfq(budget)` | — (budget is deliberately disclosed) | no | sets `budget_max`, `is_open = true` |
| `submit_bid(price)` | `price` | no | `bid_count +1`, `qualifying_count +0/1` |
| `submit_revised_bid(price)` | `price` | yes — `local_last_bid()` | `bid_count +1`, `qualifying_count +0/1`, `revision_count +1` |
| `close_rfq()` | — | no | `is_open = false` |

The two witnesses are the private-state boundary:

```compact
witness local_last_bid(): Uint<64>;      // read this supplier's previous bid
witness remember_bid(price: Uint<64>): []; // persist the bid just made
```

`submit_revised_bid` is where the dual ledger earns its keep. It asserts `price < previous` where `price` is a private circuit input and `previous` came out of private state via a witness — so the assertion constrains two values, neither of which is on-chain. If the assertion fails, no valid proof exists and the transaction cannot be produced at all. What lands publicly is a single increment.

### Private state flow

1. A supplier submits a bid. `submit_bid` proves it against the budget, then calls `remember_bid(price)`.
2. The runtime hands the witness's returned private state to the `PrivateStateProvider`, which writes it to `localStorage`, namespaced by contract address.
3. On a later revision, `local_last_bid()` reads it back into the circuit.
4. The frontend asks only *whether* a previous bid exists (`hasPreviousBid`), never the amount, so the remembered price is never rendered.

Everything in steps 1–4 happens on the supplier's machine. The only thing that crosses the network is a proof and the public counter updates.

## Tech Stack

- Midnight Network (Preprod)
- Compact — ZK smart contract language
- Midnight.js SDK (`midnight-js-contracts` v4.1.1)
- DApp Connector API (`@midnight-ntwrk/dapp-connector-api`) — works with any Midnight-compatible wallet
- React 19 + Vite 6 + TypeScript
- Jest (contract tests)
- GitHub Actions (CI)

## Prerequisites

- A Midnight-compatible wallet browser extension (e.g. [Lace](https://chromewebstore.google.com/detail/lace/gafhhkghbfjjkeiendhlofajokpaflmk)), set to the **Preprod** network
- In your wallet's settings: **Proof server → Local** (`http://127.0.0.1:6300`). Proofs are generated locally in the browser through the connected wallet, which needs a running local proof server.
- tDUST in the wallet to pay transaction fees (wallet → Tokens → Generate tDUST)
- Docker Desktop running (for the local proof server)
- Node.js v22+

## Setup & Run Locally

```bash
git clone https://github.com/JGX1019/Sealed-Quotes.git
cd Sealed-Quotes
npm install --legacy-peer-deps

# Compile the contract (outputs to managed/)
npm run compile

# Copy the contract's ZK assets into public/ so the browser can fetch them
npm run copy-assets

# Start the local proof server. Pin 8.1.0 — :latest and the 7.x line hang
# indefinitely generating proofs on Apple Silicon under Docker Desktop.
docker run --rm -p 6300:6300 midnightntwrk/proof-server:8.1.0

# In your wallet: set Proof server to Local (http://127.0.0.1:6300)

npm run dev
# Open http://localhost:5173, connect your wallet, then either:
#  - Post New RFQ (as a buyer) and open it with a budget, or
#  - Join an existing RFQ by address and submit a sealed bid (as a supplier)
```

## Run Tests

```bash
npm test
```

**59 tests passing** across two suites.

`tests/sealedquote.test.ts` (36) drives the real compiled contract with the real witness implementations:

- **Circuit logic** — the open → bid → close lifecycle, budget and price validation (zero rejected), bids rejected before opening or after closing, and re-closing an already-closed RFQ rejected.
- **State transitions** — bid and qualifying counts accumulate correctly across many suppliers, all-qualifying and all-over-budget rounds, and `qualifying_count` never exceeding `bid_count`.
- **Private state** — a fresh supplier has no remembered bid; `submit_bid` records the price locally; revisions are rejected with no prior bid, rejected when equal or higher, and accepted when strictly lower; a chain of successive reductions works; a revision that crosses under budget starts qualifying; plain bids never touch `revision_count`.
- **Privacy** — the ledger exposes only the five public fields and never a price; two different qualifying prices (or two different over-budget prices) are indistinguishable; revisions of very different magnitudes produce identical public state; neither the old nor the new price appears in serialized contract state; and the remembered previous bid is present privately while absent from every public field.

`tests/privateState.test.ts` (23) unit-tests the private-state layer itself:

- **Witnesses** — reading a remembered bid, defaulting to 0 for a new or malformed state, and never mutating the state passed in.
- **Provider** — refuses reads/writes before a contract address is set, round-trips `bigint` values losslessly (including above `Number.MAX_SAFE_INTEGER`, which a naive JSON round-trip would corrupt), persists across provider instances (i.e. survives a page reload), isolates state between contract addresses, and discards corrupted entries instead of throwing.

## CI/CD

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and on every pull request against `main`. Each run:

1. Checks out the repository
2. Installs Node.js v22 (with npm caching)
3. Installs dependencies with `npm install --legacy-peer-deps`
4. Installs the Compact compiler CLI, then runs `compact update 0.31.1` to fetch the toolchain binary
5. Compiles `sealedquote.compact`
6. Runs the full Jest test suite
7. Builds the production frontend bundle

The toolchain version is **pinned deliberately**. `compact compile` overwrites the committed `managed/` output, and newer compilers emit async circuit signatures (`Promise<CircuitResults<..>>`). With an unpinned `compact update`, CI would typecheck the test suite against different types than it was written for and the suite would fail to compile — which is exactly what happened on the first run. 0.31.1 is the compiler recorded in `managed/sealedquote/compiler/contract-info.json`.

## Product Proposal

See [PROPOSAL.md](./PROPOSAL.md)

## Demo Video

[PLACEHOLDER — will be added after recording]

## Project Structure

```
contracts/sealedquote.compact          — the RFQ contract (4 circuits, 2 witnesses)
managed/                               — compiler output (ZK keys, zkir, compiled JS)
public/managed/sealedquote/            — ZK keys/zkir served to the browser at runtime
src/contract/sealedquote.js            — compiled contract JS, statically imported by the frontend
src/hooks/useMidnight.ts               — wallet connect/disconnect hook
src/components/WalletConnect.tsx       — wallet connect/disconnect UI
src/components/RfqCard.tsx             — deploy/join, budget setup, sealed bid + revision forms, tallies
src/api/providers.ts                   — browser-side midnight-js providers backed by the wallet
src/api/contract.ts                    — deploy/join + typed circuit call helpers
src/api/privateState.ts                — private state type + witness implementations
src/api/browserPrivateStateProvider.ts — persisting PrivateStateProvider (localStorage)
tests/sealedquote.test.ts              — contract test suite (36 tests)
tests/privateState.test.ts             — private state + witness test suite (23 tests)
.github/workflows/ci.yml               — CI pipeline
PROPOSAL.md                            — product proposal
```

## Note on deployment path

The contract is deployed **from the frontend** through a connected wallet, not via a Node.js CLI script. A CLI path builds its own wallet and syncs it directly against the public indexer, which proved unreliable against Preprod during earlier builds in this series — the wallet-sdk's sync stream has no internal retry and can stall indefinitely on a transient indexer hiccup. Going through the wallet sidesteps this, since the wallet extension owns its own sync.

## License

Licensed under the [Apache License 2.0](./LICENSE).

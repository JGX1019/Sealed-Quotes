# SealedQuote

![CI](https://github.com/JGX1019/Sealed-Quotes/actions/workflows/ci.yml/badge.svg)

> A private RFQ marketplace on Midnight — sealed bids, publicly verifiable qualification, no revealed price.

## Live Demo

[PASTE LIVE URL AFTER DEPLOYING FRONTEND]

## Contract Address

| Network | Address |
|---------|---------|
| Preprod | `[PASTE CONTRACT ADDRESS AFTER DEPLOYING]` |

## What This Does

A buyer posts a request-for-quote with a public budget ceiling. Suppliers submit sealed bids: each price is checked against the budget entirely inside a zero-knowledge proof generated in the supplier's browser, so the exact price never touches the chain, never reaches the buyer, and is never visible to rival suppliers. The only public facts are how many bids came in and how many of those bids were at or under budget.

This is aimed at B2B procurement, where sealed bidding is the norm but rarely actually sealed — suppliers routinely bid conservatively because they suspect a competitor can infer their price from a leak. SealedQuote makes "sealed" a cryptographic property instead of a promise.

**Honest scope note:** this build does not pick or settle a winner on-chain — trustlessly comparing every sealed bid against every other one to find the lowest is real cryptography (an argmin circuit over private values) that didn't fit the timeline. What's implemented is the fully trustless part: proving a bid is well-formed and budget-eligible without revealing it. See [PROPOSAL.md](./PROPOSAL.md) for what a production version adds.

## Privacy Model

- **PUBLIC:** `budget_max` (the buyer's disclosed ceiling), `bid_count` (total sealed bids), `qualifying_count` (bids at or under budget), and `is_open` (whether the RFQ still accepts bids).
- **PRIVATE:** `price` — a supplier's exact bid. It's a private circuit parameter, consumed inside the ZK proof, and never stored on-chain or transmitted anywhere.
- **PROVED without revealing:** that the price is a well-formed, positive bid, and that it is at or under the buyer's published budget — without disclosing the price itself, only the boolean fact that it qualified.

## Privacy Claim

**What an on-chain observer can learn:** the contract address; the buyer's published budget; the total number of bids; how many of them qualified; whether the RFQ is still open; and, for each bid transaction, which wallet submitted it and whether that specific bid qualified.

**What an on-chain observer cannot learn:** the exact price of any bid, by anyone, at any time. A $10 bid and a $9,999 bid that both qualify are indistinguishable on the ledger; so are two different over-budget bids. No transcript, ledger field, or proof artifact contains a price, and there's no on-chain record linking a wallet to an amount.

**Honest limitation:** because `qualifying_count` updates once per bid transaction, an observer watching individual transactions learns one bit per bid — whether it qualified. The exact price stays hidden, but that single bit is disclosed by design, since publishing a verifiable qualification rate is the point. Selecting and settling a specific winning price on-chain without any bid being read at all is out of scope for this build — see [PROPOSAL.md](./PROPOSAL.md), "Mainnet Feasibility."

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

20 tests passing, covering:

- **Circuit logic** — the open → bid → close lifecycle, budget and price validation (zero/negative rejected), bids rejected before opening or after closing, and re-closing an already-closed RFQ rejected.
- **State transitions** — bid and qualifying counts accumulate correctly across many suppliers, all-qualifying and all-over-budget rounds, and `qualifying_count` never exceeding `bid_count`.
- **Privacy** — the ledger exposes only the four public fields and never a price; two different qualifying prices (or two different over-budget prices) are indistinguishable on the public ledger; different bid sequences with the same qualify profile produce identical public state; and the bid price never appears in the serialized contract state.

## CI/CD

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and on every pull request against `main`. Each run:

1. Checks out the repository
2. Installs Node.js v22 (with npm caching)
3. Installs dependencies with `npm install --legacy-peer-deps`
4. Installs the Compact compiler CLI, then runs `compact update` to fetch the toolchain binary
5. Compiles `sealedquote.compact`
6. Runs the full Jest test suite
7. Builds the production frontend bundle

## Product Proposal

See [PROPOSAL.md](./PROPOSAL.md)

## Demo Video

[PLACEHOLDER — will be added after recording]

## Project Structure

```
contracts/sealedquote.compact     — the RFQ contract
managed/                          — compiler output (ZK keys, zkir, compiled JS)
public/managed/sealedquote/       — ZK keys/zkir served to the browser at runtime
src/contract/sealedquote.js       — compiled contract JS, statically imported by the frontend
src/hooks/useMidnight.ts          — wallet connect/disconnect hook
src/components/WalletConnect.tsx  — wallet connect/disconnect UI
src/components/RfqCard.tsx        — deploy/join, budget setup, sealed bid form, tallies
src/api/providers.ts              — browser-side midnight-js providers backed by the wallet
src/api/contract.ts               — deploy/join + typed circuit call helpers
tests/sealedquote.test.ts         — contract test suite (20 tests)
.github/workflows/ci.yml          — CI pipeline
PROPOSAL.md                       — product proposal
```

## Note on deployment path

The contract is deployed **from the frontend** through a connected wallet, not via a Node.js CLI script. A CLI path builds its own wallet and syncs it directly against the public indexer, which proved unreliable against Preprod during earlier builds in this series — the wallet-sdk's sync stream has no internal retry and can stall indefinitely on a transient indexer hiccup. Going through the wallet sidesteps this, since the wallet extension owns its own sync.

## License

Licensed under the [Apache License 2.0](./LICENSE).

# Product Proposal

## What is the product, and who uses it?

SealedQuote is a private RFQ (request-for-quote) marketplace. A buyer posts a request with a public budget ceiling; suppliers submit sealed bids that are checked against that budget entirely inside a zero-knowledge proof. Nobody — not the buyer, not rival suppliers, not a chain observer — ever sees an individual supplier's price. All that's public is how many bids came in and how many of them qualified.

This targets B2B procurement, where sealed bidding is standard practice but almost never actually sealed. Suppliers routinely refuse to bid their real price when they suspect a competitor can infer it from a leaked number or a chatty buyer, so RFQs regress into anchored, uncompetitive bids. SealedQuote makes "sealed" a cryptographic guarantee instead of a policy the buyer promises to follow.

## Why Midnight specifically?

On a transparent chain, a bid has to be readable to be checked against the budget, so "sealed" reduces to trusting the buyer's UI not to leak it. Encrypting the price off-chain and posting a hash doesn't help either — the buyer (or anyone) can decrypt it, and a hash of a bounded price range is brute-forceable. The usual workaround is a trusted intermediary who collects bids and only reveals the winner, which just relocates the trust problem and gives the intermediary exactly the information suppliers didn't want shared in the first place.

Midnight lets the budget check happen without anyone having the price to check. `submit_bid`'s private witness is consumed entirely inside the proof; the only thing that becomes public is one bit — did this bid qualify — and `disclose()` marks that as the sole deliberate leak. The chain enforces a real budget constraint on real money without ever holding the number that constraint was checked against.

## Data Model

| Data Point | Type | Disclosed To |
|------------|------|--------------|
| `budget_max` — the buyer's published ceiling | Public ledger | Everyone |
| `bid_count` — total sealed bids submitted | Public ledger (Counter) | Everyone |
| `qualifying_count` — bids at or under budget | Public ledger (Counter) | Everyone |
| `is_open` — whether the RFQ is accepting bids | Public ledger | Everyone |
| `price` — a supplier's exact bid | Private witness (circuit input) | No one |
| ZK proof that a bid qualifies | ZK proof | Chain (verifies without reading the price) |

## Mainnet Feasibility

Partially, with one honest and significant gap: this build does not select or settle a winner on-chain. Trustlessly picking "the lowest of N sealed bids" without any bid ever being read requires comparing every bid against every other bid inside zero knowledge — a sorting/argmin circuit over private values, which is real, known cryptography but meaningfully more contract work than a threshold check. What ships today proves the part that's fully trustless with what we had time to build: bid validity and budget-eligibility. Picking a winner from the qualifying suppliers and negotiating final price happens off-chain, over a channel the buyer opens directly with a supplier of their choice — which is closer to how sealed-bid procurement already works in practice than it might sound, but it is a real gap between this and "fully on-chain settlement," and we're not going to pretend otherwise.

Beyond that, getting to something a real buyer would run needs: on-chain winner selection (the argmin circuit above, or a commit-then-selectively-reveal scheme where only the winner discloses); multiple concurrent, independently owned RFQs instead of one contract per request; a binding mechanism so a "winning" supplier can't walk away after selection; and — same as every level before this one — moving proof generation off a local Docker server so a supplier can bid from a link, not a dev environment.

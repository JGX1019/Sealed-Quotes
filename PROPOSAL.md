# Product Proposal

## What is the product, and who uses it?

SealedQuote is a private RFQ (request-for-quote) marketplace. A buyer posts a request with a public budget ceiling; suppliers submit sealed bids that are checked against that budget entirely inside a zero-knowledge proof. Nobody — not the buyer, not rival suppliers, not a chain observer — ever sees an individual supplier's price. All that's public is how many bids came in, how many of them qualified, and how many were verified price improvements.

Suppliers can also revise their own bid downward — a "best and final offer" round — and prove the new bid genuinely undercuts their previous one without either number, or the size of the cut, ever becoming visible to the buyer, to rival suppliers, or to the chain.

This targets B2B procurement, where sealed bidding is standard practice but almost never actually sealed. Suppliers routinely refuse to bid their real price when they suspect a competitor can infer it from a leaked number or a chatty buyer, so RFQs regress into anchored, uncompetitive bids. SealedQuote makes "sealed" a cryptographic guarantee instead of a policy the buyer promises to follow.

## Why Midnight specifically?

On a transparent chain, a bid has to be readable to be checked against the budget, so "sealed" reduces to trusting the buyer's UI not to leak it. Encrypting the price off-chain and posting a hash doesn't help either — the buyer (or anyone) can decrypt it, and a hash of a bounded price range is brute-forceable. The usual workaround is a trusted intermediary who collects bids and only reveals the winner, which just relocates the trust problem and gives the intermediary exactly the information suppliers didn't want shared in the first place.

Midnight lets the budget check happen without anyone having the price to check. `submit_bid`'s private witness is consumed entirely inside the proof; the only thing that becomes public is one bit — did this bid qualify — and `disclose()` marks that as the sole deliberate leak. The chain enforces a real budget constraint on real money without ever holding the number that constraint was checked against.

The revision flow needs something transparent chains fundamentally can't offer: **persistent private state**, not just a private input that disappears after one call. Proving "my new bid is lower than my old one" requires remembering the old one somewhere between two separate transactions, without that memory ever becoming legible to anyone but the supplier. Midnight's witness model is built exactly for this — `local_last_bid()` and `remember_bid()` read and write a private state that travels with the supplier's own client, and the circuit can constrain a relationship between two numbers it never has to disclose either of. A transparent chain has no private-state concept at all: the only way to remember a bid would be to store it publicly, which defeats the entire premise. An off-chain database would work technically, but it reintroduces the trusted intermediary this product exists to remove.

## Data Model

| Data Point | Type | Disclosed To |
|------------|------|--------------|
| `budget_max` — the buyer's published ceiling | Public ledger | Everyone |
| `bid_count` — total sealed bids submitted | Public ledger (Counter) | Everyone |
| `qualifying_count` — bids at or under budget | Public ledger (Counter) | Everyone |
| `revision_count` — proven price improvements | Public ledger (Counter) | Everyone |
| `is_open` — whether the RFQ is accepting bids | Public ledger | Everyone |
| `price` — a supplier's exact bid | Private witness (circuit input) | No one |
| `lastBid` — a supplier's most recent bid, persisted between transactions | Private state (supplier's own device) | No one — not even a future session on a different device |
| ZK proof that a bid qualifies | ZK proof | Chain (verifies without reading the price) |
| ZK proof that a revision undercuts the previous bid | ZK proof | Chain (verifies a relationship between two private numbers it never sees) |

## Mainnet Feasibility

Partially, with one honest and significant gap: this build does not select or settle a winner across *different* suppliers on-chain. Trustlessly picking "the lowest of N sealed bids from N suppliers" without any bid ever being read requires comparing every bid against every other bid inside zero knowledge — a sorting/argmin circuit over private values from different parties, which is real, known cryptography but meaningfully more contract work than a threshold check.

What ships today includes the single-supplier version of that same problem, solved: `submit_revised_bid` compares one supplier's new bid against their own previous bid, both private, with neither ever disclosed. That's a genuine step toward the harder N-supplier case — the private-state machinery (remembering a value, then constraining a later circuit call against it) is the same primitive a cross-supplier comparison would need, just applied to one party's bid history instead of a live set of competing bids. Extending it to "lowest across all suppliers" would mean the buyer's `close_rfq` circuit reading a private ledger of all sealed bids (each supplier's own witness-backed record) and running a private argmin over them — architecturally an extension of what's here, not a rewrite.

Beyond that, getting to something a real buyer would run needs: on-chain winner selection across suppliers (the argmin circuit above, or a commit-then-selectively-reveal scheme where only the winner discloses); multiple concurrent, independently owned RFQs instead of one contract per request; a binding mechanism so a "winning" supplier can't walk away after selection; moving the private-state store off `localStorage` and onto the wallet's own encrypted storage, so a supplier's bid history survives a device change and isn't readable by another script on the same origin; and — same as every level before this one — moving proof generation off a local Docker server so a supplier can bid from a link, not a dev environment.

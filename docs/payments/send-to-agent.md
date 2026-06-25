# sendToAgent — on-platform agent-to-agent payments

Pillar 5 of [docs/AGENT_BANKING.md](../AGENT_BANKING.md). Lets two agents
already funded on Averray move liquid balance between each other without
triggering an on-chain ERC20 transfer per payment.

---

## Why this exists

Two agents transacting via a plain ERC20 `transfer` pay gas per call, and
the recipient has to trust the sender's address is honest. On Averray:

- Both accounts already have positions stored in `AgentAccountCore`.
- The platform knows who's funded and who's authenticated.
- A single `positions[from].liquid[asset] -= amount` + mirroring
  `positions[to].liquid[asset] += amount` is bookkeeping, not custody
  transfer.

For the payer, this means cheap, gas-free-at-the-user-level micro-
payments after the initial deposit. For the recipient, the amount lands
in their liquid bucket and they can `withdraw()` whenever they want.

---

## Contract primitives

Two variants, both in [`contracts/AgentAccountCore.sol`](../../contracts/AgentAccountCore.sol):

| Function | Callable by | Typical caller |
|---|---|---|
| `sendToAgent(address recipient, address asset, uint256 amount)` | The sender themselves (via `msg.sender`) | A wallet signing a tx directly |
| `sendToAgentFor(address from, address recipient, address asset, uint256 amount, uint256 nonce, uint256 deadline, bytes signature)` | Service operators only, plus a valid EIP-712 signature from `from` | The backend hot signer relaying a user-signed payment intent |

Both paths:

- Revert `InvalidRecipient` for zero address or self-transfer
- Revert `ZeroAmount` for amount == 0
- Revert `InsufficientLiquidity` when the sender's `liquid[asset]` is
  short of the requested amount after outstanding debt is reserved
- Emit `AgentTransfer(from, to, asset, amount)`
- Honour the `whenNotPaused` kill-switch — paused protocols cannot move
  balance, consistent with every other mutating path in the contract

The relayed path additionally:

- Reverts `InvalidSignature` unless `signature` recovers `from`
- Reverts `ExpiredAuthorization` once `deadline` has passed
- Reverts `AuthorizationAlreadyUsed` when the same `(from, nonce)` is
  replayed

The EIP-712 domain is:

```json
{
  "name": "Averray AgentAccountCore",
  "version": "1",
  "chainId": "<current chain id>",
  "verifyingContract": "<AgentAccountCore address>"
}
```

The signed type is:

```solidity
SendToAgent(
  address from,
  address recipient,
  address asset,
  uint256 amount, // raw base units, e.g. 5 USDC = 5000000
  uint256 nonce,
  uint256 deadline
)
```

Neither makes an external call, so there's no ReentrancyGuard. The
entire state update is a bounded pair of `uint256` operations.

---

## HTTP surface

```
POST /payments/send
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "recipient": "0x...",
  "asset": "DOT",
  "amount": 5,
  "transferAuthorization": {
    "nonce": "42",
    "deadline": "1780000000",
    "signature": "0x..."
  }
}
```

Response:

```json
{
  "status": "sent",
  "from": "0x<sender-checksummed>",
  "to": "0x<recipient-checksummed>",
  "asset": "DOT",
  "amount": 5,
  "transferAuthorization": {
    "nonce": "42",
    "deadline": "1780000000"
  },
  "balances": {
    "from": { "wallet": "...", "liquid": { "DOT": 15 }, ... },
    "to":   { "wallet": "...", "liquid": { "DOT": 5 }, ... }
  }
}
```

Semantics:

- The SIWE-authenticated wallet is **always** the sender. You cannot
  specify a `from` over the HTTP — the backend refuses to relay on
  someone else's behalf, even with an admin role. If you need a third
  party to initiate a payment, that's a sub-job (see upcoming
  docs/payments/sub-jobs.md).
- The backend hot signer calls
  `sendToAgentFor(auth.wallet, recipient, asset, amount, nonce, deadline, signature)`
  against the contract with `amount` converted to the asset's raw base
  units. The EIP-712 authorization must sign that same raw amount. The
  platform signer pays gas, but the contract validates the user's
  EIP-712 intent before moving any liquid balance.
- The response echoes `nonce` and `deadline` for reconciliation but never
  echoes the signature.
- Self-transfer is rejected at both the HTTP and contract layer.
- The backend stashes both fresh account summaries in the response so
  the caller doesn't need a second `/account` round-trip to see the
  updated balances.

---

## Non-goals for v1

- **No multi-hop routing** (A → B → C in one call). Agents compose these
  themselves if they need it.
- **No scheduling** (send-at-time). That belongs to the recurring-jobs
  primitive (#10 on the sequencing table).
- **No reputation gate.** v1 lets any funded wallet send to any other
  wallet. The vision doc flags reputation-gated payments as a follow-up;
  it's a one-line addition once the recipient's reputation score is
  surfaced on the same path.
- **No auto-escrow / pay-on-delivery.** That's the sub-job escrow
  primitive (#7). `sendToAgent` is the unconditional settle-now path.

---

## Risks + guardrails

- **Mis-sent funds.** The platform has no refund path beyond "the
  recipient voluntarily sends it back." Validate recipient addresses
  before calling — both the browser and the HTTP endpoint enforce the
  20-byte hex shape, but can't tell a wrong wallet from a right one.
- **Denial-of-service.** The endpoint shares the same authenticated
  rate-limit bucket as other user operations. If a key-compromised
  account tries to drain to a stranger, the pauser hot key (see
  [docs/MULTISIG_SETUP.md](../MULTISIG_SETUP.md)) stops every mutating
  function including this one.
- **Audit scope.** The contract functions are simple but add two new
  external entry points. Flag them in the audit package alongside the
  existing escrow flows; no new invariants are needed beyond "liquid
  conservation across the two affected accounts."

---

## Metrics

Every successful call increments `http_requests_total{path="/payments/send",status="200"}`
in [/metrics](../../mcp-server/src/services/bootstrap.js). A sustained
spike on that counter vs. the `/jobs/claim` counter is a healthy signal —
it means agents are transacting with each other, not just with the
marketplace.

# x402 poster ramp — enablement runbook

**Status:** ready to execute, 2026-08-09. The ramp is merged and inert; this turns it on.
**Companions:** [`PACKET_X402_POSTER_RAMP.md`](PACKET_X402_POSTER_RAMP.md),
[`AGENT_STANDARDS_INTEROP_DESIGN.md`](AGENT_STANDARDS_INTEROP_DESIGN.md),
`scripts/ops/check-x402-ramp-readiness.mjs`.

Steps are ordered by dependency. Owner is marked on each. Nothing here is reversible-free:
step 5 puts a live payment surface on the public API, so steps 1–4 exist to make step 5
boring.

---

## Step 1 — Coinbase Developer Platform credentials · *Pascal*

The facilitator settles the payment on Base and sponsors the gas. We start on CDP for reach
and keep the adapter boundary so we are not captured by it.

1. Create or sign in to a Coinbase Developer Platform account.
2. Create an API key. **The secret is shown once** — capture it immediately.
3. Store both halves in 1Password, vault **`mainnet-backend`** (VPS-readable, because the
   backend needs them at runtime), as an item named `x402-cdp-facilitator` using the **API
   Credential** template — the same one `admin-eoa-mainnet` uses:
   - `username` → the CDP API key **ID**
   - `credential` → the CDP API key **secret**

   Use the template's own field names rather than renaming them. Consistency with the
   existing items beats field names that read nicely, and it means one convention across the
   vault instead of two.

   Put the purpose, the granted scopes, and the IP-allowlist state in `notes`, and
   `api.cdp.coinbase.com` in `hostname`. Self-describing items pay for themselves: today the
   `username`/`hostname` fields on `admin-eoa-mainnet` let the right identity be confirmed
   without ever reading the secret.

**Choose Ed25519, not ECDSA.** The adapter signs `alg: "EdDSA"` and decodes a raw Ed25519
secret, which arrives as a plain base64 string. An ECDSA key instead arrives as a PEM block
whose header names an EC private key, and will be rejected.

*(The literal PEM header is deliberately not written out here — it trips the
`averray-pem-private-key` gitleaks rule, which cannot tell documentation from a leak and
should not try.)*

**Grant no optional scopes.** Leave `Trade`, `Transfer`, `Receive`, `Export` and `Manage`
unchecked — those govern the Coinbase App/Advanced Trade brokerage account, which settlement
never touches. If the facilitator later refuses a scope we will learn exactly which one and
add precisely that, which is far better than granting `Transfer` on a key that lives on a
server.

**Claude must not see either value.** They reach the backend as `op://` references rendered
into tmpfs, exactly like every other backend secret.

**Why `mainnet-backend` and not `mainnet-critical`:** the running service genuinely needs
these. Vault choice is a permission decision, not a filing decision — see the janitor and
admin-EOA precedents.

---

## Step 2 — the Base receiving wallet · *Pascal*

This is the address every poster payment lands on. Get it wrong and payments go somewhere
nobody controls, and it looks like a working configuration until the first rebalance.

**Key property that shapes the choice: it never signs during normal operation.** Settlement
*pushes* USDC to it. The private key is only needed for periodic rebalance transfers.

1. Generate a fresh EOA — the same way you produced the rescue janitor
   `0x2b144907…6998`. Nothing about it needs to be special.
2. Store the key in vault **`mainnet-critical`** (human-only, *not* VPS-readable) as
   `x402-base-payto`, with fields `address` and `credential`, matching the admin-EOA item's
   shape.
3. Give Claude only the **address**.

**Why the key is human-only:** the backend never needs it. A key the service cannot read is
a key an attacker who owns the service cannot steal. This is the same reasoning that keeps
the admin EOA out of `mainnet-backend`.

**An alternative worth knowing and probably not taking:** `payTo` could be an exchange
deposit address, removing key management entirely and putting funds where the rebalance
already goes. Against it: exchange deposit addresses can rotate silently, which would break
the config without an error, and unexpected protocol inflows to a personal exchange account
invite compliance questions you do not want mid-experiment. Recommend the dedicated EOA.

---

## Step 3 — decide the float cap and the pool account · *Pascal, with a recommendation*

The pre-flight already caught the mistake here, so it is worth stating plainly.

**Do not use the KMS signer as the pool.** It holds ~5.4 USDC of AAC liquid, and that is the
operating float that pays curated job rewards. Committing it to x402 would starve
earn-from-zero — trading the supply side to feed the demand side.

**Recommended opening position: cap of `1` USDC, on a dedicated pool account.**

One concurrent x402 posting at a time. It is enough to prove the whole path end to end with
a real stranger and it risks almost nothing. Raise it once the path has worked once. The
cap is a config value, so raising it later is cheap; over-committing the pot early is not.

Fund the pool from the #41 test-wallet sweep rather than from the operating float or the
Aave position.

---

## Step 4 — wire the configuration · *Claude*

Mainnet backend env is **generated** — `deploy/backend.mainnet.env.template` is produced by
`scripts/ops/render-mainnet-backend-env.mjs` from the testnet template. Hand-editing it
drifts silently and `--check` will fail. Values go through the generator.

Set, with secrets as `op://` references:

```
X402_POSTING_MODE=disabled          ← still disabled at this step, deliberately
X402_PUBLIC_ORIGIN=https://api.averray.com
X402_PAYMENT_NETWORK=eip155:8453
X402_PAYMENT_ASSET_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
X402_PAYMENT_PAY_TO=<the step-2 address>
X402_PAYMENT_ASSET_EIP712_NAME=USD Coin
X402_PAYMENT_ASSET_EIP712_VERSION=2
X402_POSTING_FLOAT_CAP_USDC=1
X402_POSTING_FLOAT_RETRY_AFTER_SECONDS=900
X402_SETTLEMENT_API_KEY_ID=op://mainnet-backend/x402-cdp-facilitator/username
X402_SETTLEMENT_API_KEY_SECRET=op://mainnet-backend/x402-cdp-facilitator/credential
```

`X402_PAYMENT_ASSET_ADDRESS` was **verified** on 2026-08-09 to report symbol `USDC` on
chainId 8453 — confirmed by reading the contract, not recalled.

**`X402_PAYMENT_ASSET_EIP712_NAME` is not the symbol.** It is the token's EIP-712 domain
name, and payers use it to sign `transferWithAuthorization`. Base USDC reports `symbol()`
`USDC` but `name()` `USD Coin`. We shipped `USDC` here on 2026-08-10 and the ramp could not
accept a payment from anyone: every payer signed a digest the token does not recognise, the
signature recovered to a different address, and the facilitator returned a flat
`payment_verification_failed`. Verifying the symbol had not been the same test.

Do not copy these two values for a new asset. Read `name()` and `version()` off that
contract, and let the pre-flight below reproduce its `DOMAIN_SEPARATOR` before you trust
them.

**Configure and arm are separate steps**, matching the two-step ceremony pattern the bank
lane already uses. Everything lands while the mode is still `disabled`, so a mistake in this
step is inert.

---

## Step 5 — pre-flight, then arm · *Claude runs the check, Pascal approves the flip*

With the real values in place and the mode still `disabled`:

```bash
node scripts/ops/check-x402-ramp-readiness.mjs
```

It must pass every check — config resolves, Base reachable, `payTo` real, asset is USDC,
**the advertised EIP-712 domain reproduces the asset's on-chain `DOMAIN_SEPARATOR`**, the
pool's liquid balance covers the cap, and **the CDP credential authenticates against a
live call** rather than merely existing.

The `DOMAIN_SEPARATOR` check is the one that pays for itself. A wrong domain is invisible
from our side — the payer signs, the facilitator rejects, and nothing in our logs says the
advertisement was at fault. Reproducing the separator is proof rather than inference,
because it is the value the token itself hashes against.

Only then flip `X402_POSTING_MODE=enabled` as its own change.

**After the deploy, verify from outside**, because "enabled" and "deployed" are different
claims: `/poster/onboarding` should now advertise the x402 route, and an unauthenticated
posting attempt should return `402` rather than `401`.

---

## Step 6 — the first paid post · *both*

**We cannot test our own ramp without being an x402 payer.** Both halves now exist:

1. **USDC on Base** in the payer wallet.
2. **`scripts/ops/x402-poster-client.mjs`** — reads the `402`, signs the SIWX challenge and
   the EIP-3009 authorization, and retries with the `SIGN-IN-WITH-X` and `X-PAYMENT`
   headers. It is dry-run by default; `--commit` signs and pays, and is an operator action.

```bash
X402_CLIENT_KEY_OP="op://<vault>/<item>/<field>" \
  node scripts/ops/x402-poster-client.mjs --definition-file def.json
```

**Order it deliberately:** arm the ramp only when there is a way to exercise it. An enabled
payment surface nobody has ever successfully paid is a worse state than a disabled one —
the first person to try would be a stranger, and their money would be the test.

That was not a hypothetical. The ramp was armed on 2026-08-10 and the first `--commit`
returned `payment_verification_failed`, because the advertised EIP-712 domain was wrong for
every payer. Paying ourselves first is what found it.

**The job you post is real.** It goes live on an open public board with a real reward, and a
real worker can claim it. Do not use a "do not claim" probe definition as a payment test —
post something you actually want done, or you have set a trap and stranded the escrow.

---

## Step 7 — keeping the two sides stocked · *ongoing, Pascal operates*

The rail takes money in on Base and spends it on Hub. Nothing moves it back per
job, deliberately — the packet rules out bridging in the payment path, and
rebalancing is a periodic treasury operation over an exchange leg.

That is the right design, and it has a consequence worth stating plainly, because
it is a **working-capital** requirement rather than a plumbing one.

```bash
node scripts/ops/check-x402-inventory.mjs
```

**A rebalance costs about the same however much it moves** — Base withdrawal,
exchange in and out, Hub deposit. The bank lane measured that same shape on its
own route: 0.202% moving 10 USDC, ~21% on dust, the *same absolute cost*. So the
fee sets the minimum move, and the minimum move sets the inventory:

```
minimum sensible move  =  leg cost / tolerated friction
required Hub inventory =  that move, expressed in postings
```

At a $2 leg and 2% tolerated friction that is **$100 a time — about 95 postings**
at the cheapest posting size. The Hub pool therefore has to carry roughly $100 so
it can serve every posting between two rebalances.

Measured on 2026-08-10, the day the ramp went live: Hub pool **3.345 USDC**, which
is **3 postings** of runway, against a target of ~95. Base held 1.05, far below the
$100 that makes a move worth doing. Moving that 1.05 would cost more than the
5% fee earned on it — the entire margin on the rail.

So the operating rule is:

- **Fund the Hub pool up front**, to cover a full rebalance interval. Do not wait
  for the Base side to fund it; it cannot, economically.
- **Let the Base side accumulate** to the minimum move before repatriating.
- **Watch the Hub side, not the Base side.** Base accumulating is revenue working
  as intended. Hub draining is the ramp about to refuse paying customers, and it
  is the only one of the two that is urgent.

The check exits `2` when Hub runway falls below the threshold and `1` when it
cannot read a chain — a distinction worth keeping, since "the inventory is low"
and "we could not see the inventory" call for different responses.

**The pool is also the reward bank.** `getPooledFundingAccount()` returns the
backend signer, whose `AAC.liquid` pays curated job rewards. So poster escrow and
worker rewards draw on one balance, and a busy posting hour spends the same
money that pays workers. That conflation is tolerable at one posting a day and is
the first thing to revisit if volume arrives.

---

## What can go wrong, and what it looks like

| symptom | cause | what to do |
|---|---|---|
| Ramp will not start | float cap unset or zero | it is required by design; the bank lane chooses it |
| Config rejects `eip155:420420419` | you pointed it at our own chain | correct — settlement is Base-only, bridging per job is not supported |
| Pre-flight says credential "present but NOT authorised" | key wrong, revoked, or from the wrong CDP project | do not enable; fix the key |
| `payment_verification_failed` on every attempt, `posterFunds` unchanged | the advertised `extra` is not the token's real EIP-712 domain, so signatures recover to the wrong address | run the pre-flight; the `EIP-712 domain` check names the mismatch. This happened on 2026-08-10 with `USDC` instead of `USD Coin` |
| `x402_float_exhausted` with `limitedBy: configured_cap` | too much is in flight at once, or the cap is set below one posting | a posting costs reward + 5%, so the cap must exceed 1.05. This is ours to raise |
| `x402_float_exhausted` with `limitedBy: pooled_account_liquidity` | the Hub pool genuinely cannot front the escrow; `capRaw` reports the real balance | fund the pooled account. Step 7 sizes how much |
| The ramp refuses every posting and `committed` never falls | pre-2026-08-10 defect: settled postings were counted against the cap forever, so it only ever rose | fixed by reading the pool's live balance instead of summing the ledger. If you see this again, the live read is failing open and the cap alone is refusing |
| Payments settle but no job appears | job creation failing after verify | the poster is unharmed by design; check the platform-loss records |
| `402` never appears after enabling | deployed but not armed, or armed but not deployed | check `deployedSha` against `main` before anything else |

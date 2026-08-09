# Packet — x402 poster ramp (Track 1)

**Design:** [`AGENT_STANDARDS_INTEROP_DESIGN.md`](AGENT_STANDARDS_INTEROP_DESIGN.md)
**Owner:** Codex implements · Claude gates · Pascal operates
**Decisions taken 2026-08-09:** pooled float ("one pot"), exchange rebalance leg,
bounded external gas brokerage, this packet first.

## Goal

An agent funds a job on Averray **without holding anything on Polkadot Hub**, by paying
x402 on the chain its money is already on.

Today a poster must: SIWE → quote → `approve` → `deposit` → `createSinglePayoutJob`,
byte-exact, with a strict-equality trap where raising the reward strands funds behind a
seven-day rescue. Every step of that was measured by hand on 2026-08-09. This packet
replaces it with one HTTP retry.

## Hard constraints

**1. The settlement adapter boundary is not optional.** Settlement sits behind an
interface. The CDP facilitator is one implementation of it. **No CDP types, field names,
or error shapes leak into the domain model.** Payments are a contested standard — x402,
ACP, MPP and UCP all have backing and none has won — so a second adapter is a matter of
when. This is nearly free now and expensive to retrofit. If a reviewer cannot swap the
implementation by writing one new class, the boundary is wrong.

**2. Ordering is verify → create → settle. Never reorder.**

```
1. /verify   signature, funds, within validAfter…validBefore   → NO money moves
2. create the escrow-funded job on 420420419                    → fronted from the pot
3. /settle   on Base                                            → pulls the poster's USDC
```

This is what makes the stranding case impossible. If job creation fails we simply never
settle, and the poster's funds were never touched. If settlement fails after creation,
**we** are out of pocket, not the poster — delist and absorb it. Never invert this.

**3. Float is a parameter, not a constant.** The escrow is fronted from the pooled
account. The reserve policy governing how much of the pot may be committed to payment
float is a **bank-lane deliverable** — consume it, do not invent a number. Until it
exists, take a configured cap and **refuse new x402 postings when it is exhausted**, with
a clear reason. Degrading to "no new x402 posts" is correct; overcommitting the pot is not.

**4. Truth boundary.** Every failure tells the poster what happened and what to do. No
bare selectors, no silence. The adversarial run's findings F1 and F2 were both about this,
and they are the reason this platform gets to be trusted with a payment rail at all.

## Build

- `402 Payment Required` on the posting endpoint, advertising price, asset, network and
  `payTo`, per the x402 exact scheme.
- Accept `X-PAYMENT`, verify via the adapter, create the job, then settle.
- **Accept `SIGN-IN-WITH-X` alongside our SIWE.** It is the same EIP-4361 message we
  already verify, carried in a header — it collapses the three-request nonce/sign/verify
  dance into one. Standard SIWE libraries cannot verify it alone (it adds origin binding
  and nonce tracking), so this is an adapter, not a swap. Cheapest friction removal on the
  board.
- Enable the Bazaar extension with `discoverable: true` so we appear in the discovery
  layer — but treat the listing as portable and do not build on CDP-only assumptions.
- Record x402-funded postings distinguishably in the demand signal, so they never blur
  with directly-funded ones in any figure.

## Do not build

- **x402 native on Polkadot Hub.** Our USDC precompile reverts on EIP-3009
  `authorizationState` and Permit2 has no code at its canonical address (both verified on
  chain 2026-08-09). Settlement happens on Base; our precompile is irrelevant to it. A
  custom EIP-2612 facilitator is Track 3 ecosystem work, not a demand fix.
- **Any bridging in the payment path.** Nothing crosses chains per job. The poster's USDC
  stays on Base; the escrow is funded from the pot on Hub. Rebalancing is a periodic
  treasury operation over an exchange leg, entirely outside this packet.
- Worker onboarding for managed wallets. Cloudflare's supported-chain list does not
  include Polkadot Hub, so those agents cannot receive here whatever they can sign. They
  are posters, never workers.

## Acceptance

- A wallet holding **zero USDC on Hub** funds a live catalogue job end to end.
- Killing the process between verify and settle leaves the poster's balance **unchanged**
  and creates no job — prove it with a test, not an argument.
- Settlement failure after job creation is handled explicitly: the job is delisted and the
  loss is recorded as ours.
- Exhausted float refuses new postings with a stated reason, and says when to retry.
- The adapter boundary is demonstrated by a second, stub implementation in tests.
- No CDP identifier appears outside the adapter package.

## Companion, separate PR

**Publish an A2A Agent Card** for the platform. A2A reached v1.0 in 2026 under Linux
Foundation governance with 150+ organisations behind it, and Agent Cards are its
capability-advertisement mechanism. Small, independent of every open treasury question,
and it puts us in a discovery ecosystem that MCP directories demonstrably did not reach —
220 arrivals, zero browses.

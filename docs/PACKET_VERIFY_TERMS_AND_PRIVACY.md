# Packet: Verify terms page + privacy-policy update (one PR)

**DIRECTIVE (implementer):** build this in `averray-agent/agent` as ONE PR,
from a fresh worktree off `origin/main`. Do not review or summarise the
packet; implement it. Claude gates it, and **Pascal approves the final text
on the PR before merge.**

## Build

1. **Terms page.** Add `marketing/src/pages/terms.astro` with the Part 1
   text below.
   - Restore the `/terms` route on api.averray.com as a 302 to
     `https://averray.com/terms/`. Add it to ROOT_ENDPOINTS, the metrics
     path list, the discovery manifest and its mirrors, OpenAPI and
     PUBLIC_COMPANIONS, the same way #1496 first built it.
   - Add a footer link "Terms" and a Terms section in both `llms.txt`
     builders.
   - Update both marketing allow-lists.
   - **No draft wording anywhere:** "draft", "not approved", "proposed",
     "pending" must not appear. Replace #1496's guard test, which forbids
     /terms, with one that forbids those words.
2. **Privacy page.** Edit `marketing/src/pages/privacy.astro`:
   - add the Part 2 "Averray Verify" section;
   - add Base (Coinbase) to the sub-processors;
   - set `updated` to the merge date.
3. **The credential check (BLOCKING before merge).** Prove in code and with
   a test that the `verification-target-authorization` credential:
   - is **never** written to the stored run record, the public run
     projection, receipts, the event log or any logger call;
   - is used only for that run.

   Add a test that sends a sentinel credential and asserts it appears
   nowhere in the state store, the logs, the run JSON or the receipt.
   If it is stored anywhere, fix that first, and say so in the PR body.
4. **Truth boundary.** Every statement in the text must match the code. In
   particular:
   - run records, including `target` and `inputs`, are public by run id;
   - inconclusive runs and platform faults are not billed;
   - an expired or cancelled authorization is not charged.

   For each claim, cite in the PR body the code path that makes it true.
5. **Checks:**
   - `npm run build:site`;
   - `check:site-content`;
   - OpenAPI and discovery checks;
   - `npm --workspace mcp-server test`;
   - `npm run test:ops`.

The text follows. It was approved for drafting on 2026-10-17, and its
business decisions are fixed: refund for our own faults within 30 days,
liability capped at the run price, Zurich courts, receipts kept
indefinitely and payment records for 10 years.

## Part 1: Terms for Averray Verify (`averray.com/terms/`)

**Averray Verify: terms of use**
*Last updated [date of approval]*

### 1. Who we are
Averray Verify is operated by Pascal Kuriger, sole proprietor,
Hauptstrasse 51, 8162 Steinmaur, Switzerland ("we", "us"). Contact:
pkuriger@averray.com. See the [Imprint](/imprint/).

### 2. The service
You send a verification request to `POST https://api.averray.com/verify/runs`.
It names a published profile, a target, and inputs. We run that profile in
our sandboxed runner and return a verdict:
- `approved`, `rejected` or `inconclusive`;
- with a signed receipt.

The profiles, their limits and their prices are published at
[averray.com/pricing](/pricing/) and `https://api.averray.com/verify/profiles`.

### 3. Price and payment
- **The quote is the price.** You pay per run with x402 in USDC on Base.
  The price that applies is the one in the HTTP 402 quote for the profile
  you request, at the time you sign the authorization.
- **When you are charged:** only when the run returns `approved` or
  `rejected`. Inconclusive runs, and runs that fail because of a fault on
  our side, are not charged. An authorization that expires unused, or that
  you cancel before capture, is not charged either.
- **Payments are final on chain.** A captured payment is an on-chain USDC
  transfer and cannot be reversed by us or by anyone else. Refunds, where
  section 4 grants one, are paid as a new transfer to the paying address.

### 4. Disputing a charge or a verdict
- **How to dispute:** if you believe a charged run was decided wrongly
  because of a fault in our service, email pkuriger@averray.com within
  **30 days** of the run. Include the run id.
- **What we do:** we review the run, its receipt and its logs.
- **Our commitment:** if the verdict was caused by a fault on our side, we
  refund the price of that run to the paying address.
- **What this is not:** disagreement with a correctly applied profile is
  not a fault.

### 5. What you send us
- **You must have the right to submit what you send,** and to let us run
  it against the target you name.
- **Don't send secrets, private keys, or other people's personal data in
  the request body or inputs.** They are stored, and they are publicly
  readable (see section 6).
- **One exception: a scoped, revocable test credential for your target.**
  It may be sent only in the `verification-target-authorization` header,
  together with `target.auth`, and the profile uses it only for that run.
  Use a credential limited to the test and revoke it afterwards.
  [Confirm: the credential is not written to the run record or the logs.]
- **No attacks:** don't use the service to attack the sandbox, our
  infrastructure, or any target you are not authorized to test. We may
  rate-limit or refuse requests.

### 6. Results are public
- **Run records and receipts can be read by anyone with the run id,**
  without logging in. That includes the target and inputs you submitted,
  the verdict, and the billing status.
- **Each receipt is signed.** Anyone can check it against our published
  keys.

### 7. What a verdict is, and isn't
A verdict is automated evidence that a named profile produced a named
result on your inputs at a point in time. It is not:
- a warranty;
- a security audit;
- a certification;
- legal advice.

The service is provided as it is.

### 8. Liability
- **The cap:** to the extent the law allows, our liability for any run is
  limited to the price you paid for that run.
- **What we don't owe:** indirect or consequential loss, such as lost
  profit, lost data or business interruption.
- **What the cap doesn't cover:** liability for intent or gross negligence,
  or any other liability that mandatory law does not allow us to exclude
  (Art. 100 Swiss Code of Obligations).

### 9. Changes
- **The quote decides the price.** We may change prices, profiles and these
  terms. The 402 quote at the time you sign always decides the price of
  that run.
- **Where changes appear:** changes to these terms are published here, with
  a new date.

### 10. Law and venue
- **Law:** Swiss law applies, excluding the UN Convention on Contracts for
  the International Sale of Goods.
- **Venue:** the courts of the city of Zurich, Switzerland.
- **Consumers:** mandatory consumer-protection rules of the country where
  you live are not affected.

---

## Part 2: Additions to the privacy policy (`averray.com/privacy/`)

*Add this as a new section, update the "Where it runs" and sub-processor
lists, and set `updated` to the approval date.*

**Averray Verify (paid verification on Base)**

When you buy a Verify run, we process:
- **Payment data:**
  - the Base wallet address that signs the payment;
  - the signed x402 / EIP-3009 authorization (amount, nonce and validity
    window);
  - the resulting on-chain transaction.

  On-chain transfers on Base are public and permanent, and the same limit
  described above for Polkadot applies.
- **Run data:**
  - the profile you chose;
  - your target (for example an MCP endpoint URL or a repository
    reference) and your inputs (for example a patch or a structured
    output);
  - the verdict, the execution summary and the signed receipt.

  **Run records and receipts are publicly readable by run id.** Don't put
  personal data in them.
- **A scoped test credential,** if you send one in the
  `verification-target-authorization` header. It is used only to run your
  target for that run. [Confirm: not stored in the run record or the logs;
  kept in memory for the run only.]
- **Legal basis:** performance of the run you request and pay for, and our
  legitimate interest in keeping billing and receipts verifiable.
- **Retention:**
  - run records and receipts are kept indefinitely, so that receipts stay
    verifiable;
  - payment records for 10 years, the Swiss retention period for
    business records;
  - server logs follow the rotation described above.
- **Where it runs:**
  - Verify runs on our servers at OVH in the EU;
  - payments are read from and captured on Base through the Base public
    RPC (`mainnet.base.org`, operated by Base (Coinbase));
  - the capture transaction is signed by our key in AWS KMS (eu-central-2).

**Add to sub-processors:** Base (Coinbase) (Base RPC for payment reads
and transaction broadcast).

---


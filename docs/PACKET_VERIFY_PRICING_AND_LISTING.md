# Packet: Verify per-profile pricing, site signals and listing speed

**DIRECTIVE (implementer):** build this in `averray-agent/agent` as the
three PRs below, **one PR each, in order**, each from a fresh worktree off
`origin/main`. Do not review or summarise the packet; implement it.
Each PR is gated by Claude before merge. Each guard listed under
"Acceptance" must have a test that fails when the guard is removed.
Approvals from Pascal on 2026-10-16:
- the new prices;
- the site pages, with the terms text pending his review.

Source: the x402-list research of 2026-10-16. The listing is
https://x402-list.com/services/averray-verify: score 75, #124 of 138 in
Verification. In that category the median price is $0.01 and the p90 is
$0.10; we are the second most expensive listing at $5.

## Decisions (Pascal, 2026-10-16)

| Profile | Price | Why |
|---|---|---|
| `git-patch-tests-v1` (release-readiness, full sandbox: 2 CPU / 4 GB / 120 s) | **5 USDC** (raw 5000000), unchanged | heavy sandbox, real value |
| `mcp-failure-semantics-v1` (1 CPU / 256 MB / 30 s) | **0.25 USDC** (raw 250000) | light profile |
| `structured-output-evidence-v1` (1 CPU / 256 MB) | **0.25 USDC** (raw 250000) | light profile |

- This replaces the single 5 USDC price ratified for the growth programme
  on 2026-08-27, but only for the two light profiles.
- The billing rule is unchanged: `inconclusive_not_billed`.
- The network stays Base (`eip155:8453`) and the asset stays USDC.

## Global rules

- **One source of truth for prices.** Every place a price appears derives
  it from the profile registry: the 402 quote, `/verify/profiles`, the x402
  discovery document, `/pricing`, `llms.txt`, docs and the site page. No
  literal `5` or `0.25` anywhere else. A test must fail if a page or
  document disagrees with the registry.
- **The quote follows the requested profile.** A run is charged the price
  of the profile it asks for, never another profile's price.
- **The x402 payment flow stays the same:** verify, capture, reconcile, and
  the `(payer, nonce)` reservation (X1d–X1f). Only the price value changes
  per profile. `balanceOf` admission must compare against the quoted
  profile's price.
- **Name the consumers** (packet-rows rule). Grep and list each one in the
  PR body: `sdk/`, `discovery/` (agent-tools.json and the x402 discovery
  document), `mcp-server/src/protocols/mcp/tools.js` (`quoteVerificationRun`
  and `startVerificationRun`), `docs/` (`AVERRAY_WORKING_SPEC.md`,
  `POSTER_GUIDE.md`, the Verify docs), `site/` and `marketing/`
  (the `/verify` page), the hosted proof workflows, and test fixtures that
  assert `5000000`.
- Changes are additive where possible. No new env values are needed: prices
  are code constants per profile. Rate limits and sandbox limits stay
  as they are.

---

## PR 1: per-profile prices

**Behaviour.**
- In `mcp-server/src/services/verification-profile-registry.js`, replace
  the single `VERIFY_PROFILE_PRICE` with one frozen price object per
  profile. Keep the same shape: `amount`, `amountRaw`, `asset`,
  `decimals`, `network`, `billingRule`.
  - Each profile (around lines 121, 216 and 299 today) points at its own
    price.
  - Keep an exported `VERIFY_PROFILE_PRICES` map keyed by profile name.
- The 402 quote for `POST /verify/runs` uses the requested profile's price.
- The x402 discovery document (`payments/x402-discovery.js`) already builds
  one `accepts` entry per published profile. Each entry now carries its own
  price, so a directory that records the minimum price sees 0.25.
  - Confirm, and test, what an unpaid probe with no profile, or with an
    unknown profile, receives: it must be a 402 listing every published
    profile's requirements, or a validation error that names the profiles.
  - It must never be a 402 that quotes only 5 USDC for a request that would
    have run a light profile.
- `/verify/profiles` and `quoteVerificationRun` (MCP) return the per-profile
  price.
- Receipts and billing records store the price actually quoted and captured.

**Acceptance (each RED when its guard is removed):**
- A run of each light profile is quoted 250000 raw; a run of
  `git-patch-tests-v1` is quoted 5000000.
- A payment authorised for 0.25 cannot pay for `git-patch-tests-v1`: the
  amount check is against the quoted profile.
- `balanceOf` admission uses the quoted price.
- The discovery document lists three entries with their own prices.
- The MCP quote matches the HTTP quote for each profile.
- Inconclusive runs are still not billed.
- Existing X1d–X1f capture and reconcile tests stay green with
  per-profile amounts.
- Every fixture or test asserting a hard-coded 5000000 for a light profile
  is updated, not deleted.

## PR 2: site signals on api.averray.com and averray.com

**Behaviour.**
- In `mcp-server/src/protocols/http/public-metadata-routes.js`, add these
  routes next to `/openapi.json` and `/llms.txt`:
  - `GET /robots.txt`, `text/plain`:
    ```
    User-agent: *
    Allow: /
    Disallow: /admin/
    Sitemap: https://averray.com/sitemap.xml
    ```
  - `GET /pricing`: a JSON body generated from the registry,
    `{ "verify": [{ profile, amount, asset, network, billingRule }], "page": "https://averray.com/pricing/" }`.
    It is generated, never hand-written.
  - `GET /terms`: a 302 redirect to `https://averray.com/terms/`.
- Add the three paths to:
  - the `ROOT_ENDPOINTS` list;
  - the metrics path list in `http-helpers.js`;
  - `core/discovery-manifest.js`;
  - `docs/api/openapi.json`;
  - `public-openapi-contract.js`, if public routes are pinned there.
- Site:
  - Add `site/pricing/index.html`, built from the same registry values at
    build time (no literals; see the global rules), and
    `site/terms/index.html`.
  - Add both to `site/sitemap.xml` and link both from `site/llms.txt`.
  - Add a Pricing and a Terms section to the API `llms.txt` builder
    (`buildAgentLlmsText` / `buildVerifyLlmsSection`).
  - Both marketing allow-lists gate new public pages; update both.
- **Terms text: Pascal must approve it before merge.**
  - Use the outline from the research proposal (service, payment, your
    input, verdicts are evidence and not a warranty, acceptable use,
    changes, Swiss law plus a link to the imprint).
  - Ship it in the PR with a visible "DRAFT — pending operator approval"
    note in the PR body. Do not merge until Pascal confirms.
- Truth boundary: the pricing page states exactly what the 402 quote
  charges. The billing rule wording must match `inconclusive_not_billed`.

**Acceptance:**
- Each route returns the right status and content type.
- `/pricing` JSON equals the registry; change one and the test goes RED.
- The site pricing page's numbers equal the registry (build-time test).
- `robots.txt` disallows `/admin/`.
- `/terms` redirects.
- The new paths appear in the discovery manifest and in OpenAPI.
- `npm run build:site` is green.

## PR 3: speed of the paths the listing probes (measure first)

The listing reports p95 2758 ms against a category median of about 950 ms.

1. **Measure before changing anything.** Find which requests x402-list
   probes: the base URL `https://api.averray.com/`, the unpaid 402 on
   `POST /verify/runs`, `/openapi.json`, `/llms.txt`.
   - Time each from outside: 20 sequential requests, giving p50 and p95.
   - Time each from inside the server with the existing request metrics.
   - Put the table in the PR body.
2. **The unpaid 402 must do no chain reads.**
   - Producing the 402 (payment requirements) must not call RPC:
     `eip712Domain()` and anything else that reads the chain must be cached
     at startup, or with a TTL.
   - The X1f `balanceOf` admission check and the 8-second admission
     deadlines (X5a) apply only to **paid** requests, which carry a
     payment signature.
   - Test that an unpaid probe makes zero provider calls, using a provider
     mock that counts calls.
3. **Cache the static bodies:** the root `/`, `/openapi.json` and
   `/llms.txt` responses are built once per process (or per deploy) with an
   ETag. They must not be rebuilt per request.
4. **Report after deploy:** the same external timing, before and after.

**Acceptance:**
- An unpaid 402 makes no provider calls; the test goes RED if
  `eip712Domain` is read per request.
- The static bodies are built once, with a counter test.
- The measured p95 for the probed paths is in the PR body, before and
  after.
- No paid-path behaviour changes, and the X1d–X1f tests stay green.

## After deploy (operator)

- The listing picks up the new prices from the captured 402. No listing
  edit is needed; an owner update is optional at
  https://x402-list.com/services/averray-verify/update.
- What actually moves the score is **real buyers.** Traction only counts
  from $10 of sales in 30 days. The $0.25 light profiles make first buyers
  plausible; outreach to find them is a separate decision.

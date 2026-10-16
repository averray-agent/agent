# Verify site signals

The published profile catalogue owns Verify identities and prices.
`mcp-server/src/core/verification-profile-prices.js` is dependency-free; the
profile registry imports its immutable values and retains the public
`VERIFY_PROFILE_PRICES` export. `buildVerifyPricing` projects those values into
the Astro pricing table at <https://averray.com/pricing/>. The API's public
`GET /pricing` explicitly passes `verificationRunService.listProfiles()` to
the same projection. A parity test compares the complete build-time catalogue
with the published registry, and built-HTML tests compare visible price cells.

Before signing, buyers must read the requested profile's live 402 quote.
Existing authorizations retain their quoted amount when policy changes. The
billing rule remains `inconclusive_not_billed`: approved and rejected verdicts
are billable; inconclusive results are not billed. The llms pricing section
uses `VERIFY_BILLING_RULE` instead of maintaining separate billing copy.

The API also serves `GET /robots.txt` as plain text: allow public crawling,
disallow `/admin/`, link the site sitemap. Both reads appear in the root
endpoint list, metrics inventory, discovery manifests and OpenAPI.

`npm run build:site` generates the pricing page, sitemap entry and `llms.txt`.
The maintained site orientation source is `marketing/src/content/llms.txt`;
its Pricing section shares the API builder. Both marketing allow-lists and
deployment byte checks cover pricing and llms output. Generated HTML is not
committed. The discovery manifest is the existing verified generated-source
exception.

The content tests in `agent-playbooks.test.js`, `public-openapi.test.js`,
`public-metadata-routes.test.js` and `marketing-blind-tester-ux.test.mjs` read
that maintained source. `llms-source-consumers.test.js` rejects source readers
of the stale committed generated artifact; the sole permitted reference is a
write-only deployment fixture. Built-output tests also check the published
playbook and OpenAPI links.

Validation includes route and real-HTTP status/content-type tests, alternate
registry prices, inventory and OpenAPI checks, isolated Astro builds, visible
price/billing assertions, sitemap/llms/footer checks and served-byte parity.
The pricing import-graph test prevents importing backend runtime dependencies
into the static build.

Terms are outside PR 2 following Pascal's scope change. A separate draft PR
may open only after Pascal approves revised text covering a liability cap,
payment finality and a dispute route, a scoped-credential exception for
`target.auth`, public results and receipts, and a Verify privacy-policy update
(Base payer addresses, x402 authorizations, inputs, runner location and
retention). This PR publishes no terms route, page, link or draft notice.

PR 3 owns listing price-selection investigation and performance measurement.
Do not infer x402-list's choice between `maxAmountRequired` and multiple
`accepts[].amount` values from this PR's metadata or build results.

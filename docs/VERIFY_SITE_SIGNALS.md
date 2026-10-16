# Verify site signals

The profile registry owns Verify prices. `buildVerifyPricing` projects the
published profiles into the public `GET /pricing` response and the Astro
pricing table at <https://averray.com/pricing/>. Neither consumer has its own
price constants. Before signing, buyers must read the requested profile's live
402 quote. Existing authorizations retain their quoted amount when policy changes.

The billing rule remains `inconclusive_not_billed`: approved and rejected
verdicts are billable; inconclusive results are not billed.

The API also serves `GET /robots.txt` as plain text (allow public crawling,
disallow `/admin/`, link the site sitemap), and redirects `GET /terms` with a
302 to <https://averray.com/terms/>. These reads are public and appear in the
root endpoint list, metrics inventory, discovery manifests and OpenAPI.

The terms page is **DRAFT — pending operator approval**. Pascal must approve
its text before PR 2 merges. The draft notice appears on the page and in both
llms surfaces. Removing it is an explicit follow-up after approval, not an
implicit consequence of a passing build or CI run.

`npm run build:site` generates the pricing and terms pages, sitemap entries,
and `llms.txt`. The site's existing orientation text now lives in
`marketing/src/content/llms.txt`; its Pricing and Terms sections share the API
builder. Both the marketing sync allow-list and deployment byte checks cover
the new pages and llms output. Generated HTML is not committed. The discovery
manifest is the existing verified generated-source exception.

Validation:

- Public metadata route tests compare prices to registry fields, including
  alternate policy values, and pin crawler policy, redirect, links and inventories.
- HTTP smoke exercises the real server without auth and compares `/pricing`
  with `/verify/profiles`, including content types and status codes.
- `scripts/ops/verify-site-signals.test.mjs` builds Astro into an isolated
  directory, compares visible pricing cells with the registry, and checks the
  billing wording, draft terms, sitemap, llms, footer and both allow-lists.
- Deployment tests verify that served pricing, terms and llms bytes match the
  build. Discovery/OpenAPI checks guard their public contract.

PR 3 owns listing price-selection investigation and performance measurement.
Do not infer x402-list's choice between `maxAmountRequired` and multiple
`accepts[].amount` values from this PR's metadata or build results.

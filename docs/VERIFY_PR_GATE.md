# Gate an MCP endpoint or a patch with Averray Verify

For an MCP gate, start with the registry's `mcp-failure-semantics-v1@1`
worked request (replace the example endpoint before purchasing):

```json
{"profile":"mcp-failure-semantics-v1","profileVersion":1,"target":{"endpoint":"https://example.invalid/mcp","transport":"streamable_http"},"inputs":{}}
```

This is a bounded observation of five named failure-semantics checks, not a
security certification. The second path, `git-patch-tests-v1@1`, checks that a
pinned source fails the requested tests before a patch and passes afterward.
Both use the same paid resource and the same flow below. No browser or Hub
wallet is needed. Worker claim/submit/list tools are separate and remain free.

## 1. Discover the resource and read its price live

```sh
API=https://api.averray.com
curl --fail --silent --show-error "$API/.well-known/x402" > discovery.json
jq -e '.resources | length == 1' discovery.json
jq -e '.resources[0].resource == "https://api.averray.com/verify/runs"' discovery.json
jq '.resources[0] | {resource, maxAmountRequired, accepts, requirementsBinding}' discovery.json
```

There is exactly one advertised resource today. Stop if it is absent or differs;
do not guess another payment door. Read the price from discovery, not this page.
Amounts are exact base-unit integer strings. The resource's `maxAmountRequired`
summarizes its advertised requirements; the fresh challenge uses `accepts[0].amount`.

Verify's payment identity is Base `eip155:8453`, native USDC token
`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, receiving address
`0x1013e3fe3f6deb4e61dc023ff69d420dd9ce8f9f`. Check all three against discovery
and the fresh challenge before authorizing payment. Do not bridge or substitute
an identically named token on another network.

## 2. Take a published request, then supply your own target

```sh
curl --fail --silent --show-error "$API/verify/profiles" > profiles.json
PROFILE=mcp-failure-semantics-v1
jq -e --arg profile "$PROFILE" '.profiles[] | select(.name == $profile and .version == 1)' profiles.json
jq --arg profile "$PROFILE" '.profiles[] | select(.name == $profile and .version == 1) | .workedExample.request' profiles.json > request.json
jq --arg profile "$PROFILE" '.profiles[] | select(.name == $profile and .version == 1) | {availability, limits, price, notes: .workedExample.notes}' profiles.json
```

Use `workedExample.request` verbatim as the starting shape: `profile`, integer
`profileVersion`, object `target`, object `inputs`. Read availability and input
limits first. Replace the endpoint in `request.json` with the reachable MCP
endpoint you want observed. For a protected endpoint, follow the registry's
`target.auth` instructions and pass the scoped credential only in
`Verification-Target-Authorization: Bearer …`, never in the JSON or an artifact.

For a PR/patch gate, set `PROFILE=git-patch-tests-v1` instead and extract its
worked example with the same commands. Its exact starting shape is:

```json
{"profile":"git-patch-tests-v1","profileVersion":1,"target":{"repository":"https://example.invalid/repository.git","commit":"0000000000000000000000000000000000000000"},"inputs":{"gitBundle":{"sha256":"1111111111111111111111111111111111111111111111111111111111111111","bytes":123456,"locator":{"kind":"https","url":"https://example.invalid/repository.bundle"},"format":"git-bundle"},"patch":{"sha256":"2222222222222222222222222222222222222222222222222222222222222222","bytes":1234,"locator":{"kind":"https","url":"https://example.invalid/candidate.patch"},"format":"file"},"testCommand":["npm","test"],"workingDirectory":".","allowedPaths":["**"],"protectedPaths":[],"maximumChangedFiles":100}}
```

These are placeholders, not purchasable proof fixtures. Pin your actual commit;
publish a binary-safe, single-head git bundle and patch at stable HTTPS URLs;
replace their SHA-256 hashes and byte lengths with the actual values. Supply a
test executable and arguments as an array, not a shell string. The runner is
offline: bundle the inputs needed by the test, rather than relying on downloads.
Never sign a request still containing the example target or artifact placeholders.

## 3. Request the real challenge, unpaid

```sh
status=$(curl --silent --show-error -o challenge.json -D challenge.headers -w '%{http_code}' \
  -H 'Content-Type: application/json' --data-binary @request.json "$API/verify/runs")
test "$status" = 402
jq '.accepts[0]' challenge.json
```

A well-formed unpaid request returns **402** and `PAYMENT-REQUIRED`. A malformed
body returns **400**, not a payment challenge. Do not sign after a 400.
Discovery's requirements are bound to the published examples. For your edited
request, use this fresh `accepts[0]` unchanged, including `extra.profile` and
`extra.requestHash`; do not sign the example's stale requirements.

## 4. Authorize exact Base USDC, then retry the identical request

Use your x402 v2 client and your locally held Base account to sign the EIP-3009
`TransferWithAuthorization`. This is an authorization signature, **not an
on-chain transaction sent by the buyer**. Averray submits it only after a
decisive result. No key or bearer login token is sent to Averray.

The client must bind `to` to `payTo`, `value` to the exact `amount`, and the
EIP-712 domain to the challenge's `extra.name` / `extra.version`, Base chain id
and token address. Use a fresh bytes32 nonce, a `validAfter` already in the past,
and a `validBefore` beyond now plus `maxTimeoutSeconds` (allow transport time).
Underpayment, overpayment and insufficient validity are refused. Never use the
token symbol as the signing-domain name.

The x402 client returns the base64-encoded v2 proof with `accepted` equal to the
fresh requirement and `payload` containing its signature and authorization.
Keep the proof private. With that proof in `PAYMENT_SIGNATURE`, retry:

```sh
curl --fail --silent --show-error -H 'Content-Type: application/json' \
  -H "PAYMENT-SIGNATURE: $PAYMENT_SIGNATURE" --data-binary @request.json \
  "$API/verify/runs" > run.json
jq '{runId, status, billing, asyncStatus}' run.json
```

Only a buyer intentionally purchasing a run executes this step. No repository
test or CI job purchases it. Do not mutate `request.json` between challenge and
paid retry. `queued` means accepted for asynchronous work, not a verdict or a
completed charge. Poll the returned run instead of creating a second purchase.

## 5. Read the public result and decide the gate

```sh
RUN_ID=$(jq -er '.runId' run.json)
curl --fail --silent --show-error "$API/verify/runs/$RUN_ID" > result.json
jq '{status, verdict, billing, receiptId, receiptUrl}' result.json
```

`GET /verify/runs/{runId}` is public and unauthenticated; unknown ids return 404.
Poll with a bounded interval until `status` is `complete`. Approve your PR gate
only on an `approved` verdict, not HTTP 200 or `queued`. A `rejected` verdict is
decisive and billable too. Inspect the named checks and evidence before acting.

The billing rule `inconclusive_not_billed` comes from each profile's
`price.billingRule` at `/verify/profiles`, **not the 402 body**. Inconclusive or
platform-fault results do not charge; capture failure is reported as not billed,
not a successful purchase. Distinguish these from an artifact rejection. Do not
retry automatically with a new payment authorization.

## 6. Optional portable receipt

When a completed run supplies `receiptId`, open
`https://averray.com/receipts/{receiptId}` (or its returned `receiptUrl`). This is
evidence for one pinned verification, not a guarantee about the entire endpoint,
repository or future behavior. Run results and receipts are public: do not submit
private material expecting a private report.

## Deferred: credit packs

The 10× credit pack is deferred: runner and facilitator unit cost is not recorded,
so a minimum redemption price covering those costs cannot yet be enforced. Unit
cost measurement is separate work; this recipe adds no balance, ledger or rail.

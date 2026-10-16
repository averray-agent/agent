# Verify listing paths: measurement and request work

PR 3 starts from `ce811b58` (PR #1496). The external and internal baselines
were recorded before changing serving or payment code. Raw samples are in
[`evidence/verify-listing-speed/`](evidence/verify-listing-speed/).

## Measurement

Each path receives 20 sequential requests, without payment or warmup. p50
and p95 use nearest rank (sorted samples 10 and 19). The production external
sample uses fresh curl processes/connections from Pascal's workstation;
latency includes connection establishment and the complete response body.
It is not the directory crawler's network location or historical window.

Production `/metrics` returned 401. The internal measurements therefore use
the actual HTTP server in an isolated local process, with a memory store
and a deterministic loopback RPC fixture. The fixture serves Base's domain
reads and rejects unrelated chain calls; it never sends a transaction.
Its generated signer is ephemeral and unfunded. Internal samples are the
per-request differences of the existing `http_request_duration_ms_sum`,
whose observations have integer-millisecond precision. A zero means below
that resolution. Verify currently uses the `POST`/`other` metric label;
this isolated process receives no other POST requests, so those deltas are
unambiguous. The metric registry itself has no quantile buckets.

| Endpoint | External before p50 / p95 (ms) | Internal before p50 / p95 (ms) | Internal after p50 / p95 (ms) |
|---|---:|---:|---:|
| `GET /` | 93.406 / 98.334 | 0 / 2 | 0 / 0 |
| unpaid `POST /verify/runs` (`{}`) | 98.513 / 127.804 | 1 / 20 | 0 / 0 |
| `GET /openapi.json` | 158.015 / 220.426 | 1 / 2 | 0 / 0 |
| `GET /llms.txt` | 88.825 / 98.606 | 0 / 0 | 0 / 0 |

The first baseline unpaid probe made three Base provider calls; later
probes reused the domain cache. After the change, the three calls finish
before the server listens, and every unpaid probe makes zero provider
calls. The pre-handback after sample was taken after the full suites stopped; an earlier
exploratory after sample had p95 values of 1 / 3 / 5 / 0 ms respectively.
Short local timing samples are noisy; the counter tests establish
removed work independently of p95. No claim is made that local timings
predict a listing score or production latency improvement.

External **after-deploy** timing is pending merge and deployment of PR 3.
Repeating the production baseline before deployment would still measure
PR 2. The same command below should be run once the new revision is live,
and its external p50/p95 table added to the PR handoff.

```sh
python3 scripts/ops/measure-verify-listing-external.py \
  --revision DEPLOYED_SHA --output /tmp/listing-external-after.json
node scripts/ops/measure-verify-listing-internal.mjs /tmp/listing-internal.json
```

The internal script can also run against the baseline checkout (it imports
that checkout's route label function). `--assert-guards` additionally checks
startup RPC count, zero calls per request, and real HTTP ETag/304/HEAD
behavior. The HTTP smoke suite runs this guard automatically.

## Implementation and failure behavior

The configured Verify gate factory is asynchronous. Bootstrap awaits it,
validating the chain ID, token name and reproduced EIP-712 domain separator
before accepting requests. The existing domain promise cache is retained;
no authorization, balance, nonce, capture or reconciliation logic changes.
Startup validation uses an eight-second bound and always retains a correctly
configured gate. A transport failure or timeout retries in the background
with 1/2/4/8/16/30-second capped backoff. Requests inside the same
`domainNextAttemptAt` window immediately reuse the 503 with a `Retry-After`
header and make zero provider calls. The first request after the deadline
can start the retry; concurrent attempts share one promise. Successful
recovery stops retries and caches the domain again. Chain ID, token name and separator mismatches
stay fail-closed until operator correction and restart. Paid admission
retains its existing deadlines and in-flight captures retain their gate.

The Base provider uses `staticNetwork`; the gate explicitly reads
`eth_chainId` to validate the chain before caching the domain. Its
`FetchRequest` has an eight-second transport timeout and one attempt,
so ethers cannot add independent network-detection or HTTP 429 retry
loops. Provider errors and gate state transitions use the structured
logger and honour `LOG_LEVEL`.

While the domain is unavailable, unpaid probes and x402 discovery return
HTTP 503 `payment_domain_unavailable`, with `details.status: unavailable`
and `Cache-Control: no-store`. No empty healthy discovery or 402 without
requirements is emitted. The agent-card and ai-agent discovery aliases
remain HTTP 200 with all descriptive metadata and
`pricing: { status: "unavailable" }`, using `Cache-Control: no-store`.
`/health` is degraded with the warning
`verify_payment_domain_unavailable`; process liveness keeps its existing
HTTP status policy. A successful retry clears the warning without restart.
The real-server smoke fixture verifies boot outage, recovery and zero
provider calls on subsequent probes/discovery; `--assert-recovery` runs
that scenario in the internal measurement script. `--rpc-429` exercises
rate limiting and `--assert-hung-recovery` holds the RPC connection open.
Both variants assert recovery without restart within a maximum backoff
window, cached 503s for request bursts, Retry-After and both available cards.
A separate wire test bounds transport timeout independently of admission.

The root, OpenAPI and llms representations share one build promise per
router/process, including concurrent first requests. JSON serialization,
text conversion, byte length and SHA-256 ETag are computed once. A failed
build can retry. GET and HEAD use the same bytes/validator; matching
`If-None-Match` (including weak/list/wildcard forms) returns a bodyless 304.
CORS and request IDs are still applied per request. OpenAPI documents the
new conditional response. Deployment/process restart refreshes the cache.

Counter tests exercise the actual route/service/gate with a counting
provider and the static routes with counting builders and serializers.
The full payment suite retains the X1d–X1f price and stored-authorization
reconciliation guards. Mutation drills cover startup warmup, bootstrap
awaiting, domain cache reuse, static build/serialization reuse, ETag bytes,
conditional responses, cache headers, 304 length and HEAD suppression.
Handback drills additionally remove background/lazy retry, promise reset,
the timeout, backoff cap, fail-closed mismatch guard and health warning;
they also substitute a healthy empty discovery and inject a root build
timestamp. Independent routers built a day apart must produce identical
bytes and ETags for every cached representation.

## x402-list price and probe evidence

The [public listing](https://x402-list.com/services/averray-verify) and
[service API](https://x402-list.com/api/v1/services/averray-verify) now show
the light-profile price. The recorded atomic price comes from the saved
402's `accepts[].amount`, whereas Averray's discovery document still
truthfully reports the heavy-profile `maxAmountRequired`. The maximum is
therefore **not** forcing this listing to display the heavy price.

The directory's saved envelope has only one accept. Its implementation
is not exposed by the public API, and no public crawler source was found;
these observations cannot distinguish `min(accepts[].amount)` from selecting
the first accept. We do not change or understate the discovery maximum.
The dated field-level evidence is in
[`listing-price-observation.json`](evidence/verify-listing-speed/listing-price-observation.json).
Data attribution: x402-list.com, CC BY 4.0.

The [checks API](https://x402-list.com/api/v1/services/averray-verify/checks)
records recurring 402 responses, and the service identifies its paid path
as `POST /verify/runs`. Its site assessment exposes homepage, OpenAPI and
llms checks. All four requested surfaces were measured, but public data
does not prove that all four enter the same historical latency statistic.
No directory submission/update or paid probe was sent.

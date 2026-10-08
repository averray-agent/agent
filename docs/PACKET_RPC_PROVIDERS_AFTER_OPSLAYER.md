# PACKET — RPC providers after OpsLayer: two live providers now, an operator-independent third one as a pilot

**Status:** ready for Codex (Track 1) and Pascal + Codex (Track 2), 2026-10-07. Decision taken by Pascal the same day: "go with Dwellir". This packet states what that means in practice, because Dwellir does not sell the thing we lost.

## What was verified on 2026-10-07

- `services.polkadothub-rpc.com` (OpsLayer) has been NXDOMAIN since 2026-09-30 for the whole domain, mainnet and testnet paths alike. The community chain list still carries it; a pull request removing it is open (ethereum-lists/chains#8820). The official docs list exactly two Ethereum JSON-RPC providers for Polkadot Hub: Parity `https://eth-rpc.polkadot.io/` and the dead OpsLayer one. No third party advertises an eth-rpc for chain 420420419.
- Today every mainnet consumer names the dead host as **primary** and runs on the backup alone: backend (`RPC_URL`, `DWELLER_RPC_URL`, `POLKADOT_RPC_URL` all = OpsLayer, `RPC_BACKUP_URLS` = eth-rpc), indexer (`DWELLER_RPC_URL` = OpsLayer is the first alias in `resolveIndexerRpcUrls`), `deployments/mainnet.json`, the sidecar preflight, two ops scripts, and the operator app's `wallet_addEthereumChain` list. The indexer's cross-check therefore has **one** provider, which `deploy/indexer.mainnet.env.template` itself says is "no defence".
- **Dwellir** offers Polkadot Asset Hub as a **Substrate** RPC only: `https://api-asset-hub-polkadot.n.dwellir.com/<key>` and `wss://…/<key>` (403 "API key does not exist" without a key; the host resolves; no `*eth-rpc*` Dwellir host exists). Going with Dwellir means running Parity's `eth-rpc` adapter ourselves against Dwellir's node. The adapter is a small binary (`paritypr/eth-rpc`, 45 MB image, amd64; `stable2609-a27798a2` = `sha256:cff89059f2e309216461096d54ed2b677f6f9cf2f9f6ad0998b885740db39954`, built 2026-10-07) that takes `--node-rpc-url <ws(s) url>` and serves Ethereum JSON-RPC on `--rpc-port` (default 8545). Two storage modes: `--eth-pruning archive` (default; syncs **all** history backwards from the head, needs an archive node and a persistent database) or `--eth-pruning N` (in-memory, latest N blocks only). The flags `--database-url`, `--index-last-n-blocks`, `--earliest-receipt-block` were removed upstream.
- **Blockscout's eth-rpc proxy** `https://blockscout.polkadot.io/api/eth-rpc` is live and answers for chain `0x190f1b43` (420420419). Parity against `eth-rpc.polkadot.io`, measured: identical `eth_getLogs` over blocks 20689770–20689780 (the two DisputeOpened events, same indices), identical `eth_call` (USDC `balanceOf`), identical receipt, and an identical 43,200-block `eth_getLogs` on AgentAccountCore (the ops board's wide window). Rate limit from response headers: **500 requests per window per IP** (`x-ratelimit-reset` counts down in milliseconds; ~15 min observed). Enough for a backend that only hedges to it; not enough for the indexer, which asks every provider for every block range.

## The shape

| Role | Provider | Why |
|---|---|---|
| Primary, everywhere | `https://eth-rpc.polkadot.io/` (Parity) | The only full public eth-rpc left; already the de-facto primary. |
| Backend backup 1 (after Track 2) | `http://mainnet-eth-rpc:8545` (our adapter on Dwellir's node) | Operator-independent of Parity; unlimited for us. |
| Backend backup 2 | `https://blockscout.polkadot.io/api/eth-rpc` | Zero infrastructure, parity proven, rate-limited: last in the list. |
| Indexer cross-check provider | `http://mainnet-eth-rpc:8545` only | The cross-check needs a provider without a request budget. Until Track 2 ships, the indexer runs single-provider and the template says so. |

## Track 1 — Codex PR A: configuration only, ships now

One PR, no new infrastructure. Backend, indexer, deploy scripts and app are all touched by a URL change, so this is the one exception to "split by area"; keep the diff to URL/ordering changes and the tests that pin them.

1. `scripts/ops/render-mainnet-backend-env.mjs`: `MAINNET_BACKEND_RPC = "https://eth-rpc.polkadot.io/"`; `RPC_BACKUP_URLS: "https://blockscout.polkadot.io/api/eth-rpc"`; fix the header comment (line 20). Regenerate `deploy/backend.mainnet.env.template` with the generator and commit the output together with the generator.
2. `deploy/indexer.mainnet.env.template`: `DWELLER_RPC_URL=https://eth-rpc.polkadot.io/`, `RPC_BACKUP_URLS=` empty, and rewrite the comment block to say: single provider until the eth-rpc sidecar (Track 2) exists; Blockscout is excluded because of its request budget; keep the 2026-09-10 incident paragraph.
3. `deployments/mainnet.json`: `rpcUrl` → eth-rpc, `rpcBackupUrls` → `[blockscout]`. `selectRpcUrl` in the funding script (#1423) probes in that order.
4. Testnet surfaces, same disease: `deployments/testnet.json`, `deployments/discovery-registry-testnet.json`, `deploy/backend.env.template` (lines 391–394), `deploy/indexer.env.template` (line 30) → `https://eth-rpc-testnet.polkadot.io/` primary. Probe `https://blockscout-testnet.polkadot.io/api/eth-rpc` with `eth_chainId` (expect `0x190f1b41`) before adding it as the testnet backup; if it does not answer, leave the testnet backup empty and say so in the template.
5. Pinned values: `scripts/ops/preflight-mainnet-sidecar.sh:82-83` (backend `RPC_URL`, `RPC_BACKUP_URLS`) and `:89` (indexer). `scripts/ops/check-x402-inventory.mjs:49` and `check-x402-ramp-readiness.mjs:32` default `HUB_RPC` → eth-rpc. `check-mainnet-deploy-readiness.mjs:140` already expects eth-rpc in `RPC_URL`; it starts passing.
6. `app/lib/wallet/funding.ts:45`: drop the dead URL from `rpcUrls`; eth-rpc first. MetaMask tries the list in order when adding the chain.
7. Tests to update, not delete: `scripts/ops/deploy-production.test.mjs:2614` (asserts the old primary), `render-mainnet-backend-env.test.mjs:111`. Fixtures that merely use the old URL as an opaque string (`indexer/src/api/rpc-transport.test.ts`, `ceremony-rpc.test.mjs`, the mcp-server service tests) stay as they are.
8. Add one test: the rendered mainnet backend template contains no `polkadothub-rpc.com` line, and the indexer template's `RPC_BACKUP_URLS` does not contain `blockscout` (the budget rule above, pinned). *Mutations: put the old host back; put Blockscout into the indexer list.*
9. After deploy, read the backend's RPC failover counters for 24 h. `RPC_FAILOVER_STALL_MS=250` hedges to the backup whenever the primary is slower than 250 ms, which will now spend Blockscout's budget; if the logs show 429s from Blockscout, raise the stall (e.g. 750 ms) in a follow-up — measure first, do not tune blind.

The transparency reader's "no read" (QA #2) is diagnosed separately in the QA packet's PR 2; Track 1 only makes its label point at a live host.

**Local checks:** `npm --workspace mcp-server test`, `npm run typecheck:indexer`, `npm run test:ops`, `npm run typecheck:app`.

## Track 1b — Codex PR A2: the gateway's read provider must actually fail over (separate PR, after PR A)

Found while gating #1428 (2026-10-08). ethers v6 `FallbackProvider` with quorum 1 counts a child's *fast* error (`SERVER_ERROR` 503/429, `NETWORK_ERROR`, `TIMEOUT`) as a quorum-meeting result and throws before consulting the backup; only a blackholed or NXDOMAIN primary (excluded at the initial network sync) fails over today. So "never says no read while a backup answers" holds for the dead host we have, not for a primary that answers 503.

A first attempt at a `ReadFailoverProvider` (retry `call` across children on those error codes) did not deliver, for three reasons that the fix must address, each with a test that fails the primary at the TRANSPORT layer (a local HTTP server answering 5xx / closing the socket), never by mocking `_perform`:
1. `AbstractProvider.call()` runs `getNetwork()` → `_detectNetwork()` → `_perform({method:"chainId"})` on every call; children re-send `eth_chainId` batched with `eth_call`, the chainId read fails first and is rethrown because its method is not `call`. Give children `staticNetwork` (the chain id is fixed per manifest; `selectRpcUrl` already verifies it) and/or include `chainId` in the retry set.
2. Node transport errors arrive unwrapped: `ECONNREFUSED`/`ECONNRESET` have no ethers `code`, and `fetch failed` is code-less; reuse the file's existing `isRetryableBroadcastError` message-fragment matcher instead of an error-code allow-list.
3. The retry loop must skip the config that just failed (it re-hit the primary first, +≤750 ms per failover) and must not abort on the first code-less error before reaching the backup.
Tests: primary healthy at sync then 503 on `eth_call` → backup answers and the proof label names the backup host (this is also the "answering host, not attempted host" test from the transparency row); primary port closed mid-life → backup answers; `CALL_EXCEPTION` (a revert) is NOT retried. Drill: record the label before the await → RED.

## Track 2 — the Dwellir-fed adapter (pilot with an exit condition)

### Operator items (Pascal)

1. Dwellir account at dashboard.dwellir.com; create an API key. The free tier (20 RPS) covers the pilot: following the head costs a handful of calls per 6-second block. Upgrade only if archive mode is chosen later (see caveat).
2. Store the keyed endpoint as one item: `op://mainnet-backend/dwellir-asset-hub-polkadot/url` = `wss://api-asset-hub-polkadot.n.dwellir.com/<key>`. The vault choice matters: the sidecar's env is rendered with the **backend** VPS token, which reads `mainnet-backend`. Never put the key in a template, the compose file, or chat.
3. Paste `free -m` and `df -h /` from the VPS so the memory limit in PR B is a number, not a guess.
4. Calendar: entry `dwellir-asset-hub-polkadot` with `rotate_by` (vendor key, no intrinsic expiry), `vault_path` as above.

### Codex PR B: the service

- `deploy/eth-rpc.mainnet.env.template` with a single line `DWELLIR_ASSET_HUB_WSS=op://mainnet-backend/dwellir-asset-hub-polkadot/url`. Extend `render_runtime_envs` in `scripts/ops/deploy-production.sh` (`for runtime in backend indexer`) with `eth-rpc`, template above, **token = the backend token** (`op-backend.env`), target `/run/agent-stack-mainnet/eth-rpc.env`, its own `RUNTIME_ENV_CHANGED_ETH_RPC` so a changed key recreates only this container. Add the file to `scripts/ops/preflight-mainnet-sidecar.sh` and to `check-env-template-structure.mjs`'s list.
- `deploy/docker-compose.mainnet.yml`: service `mainnet-eth-rpc`, `image: paritypr/eth-rpc@sha256:cff89059f2e309216461096d54ed2b677f6f9cf2f9f6ad0998b885740db39954` (re-resolve a current `stable*` tag's digest at PR time and state it), `command: ["--node-rpc-url", "${DWELLIR_ASSET_HUB_WSS}", "--eth-pruning", "100000", "--rpc-port", "8545", "--unsafe-rpc-external"]` (binding beyond loopback is required for other containers to reach it; no `ports:` published to the host; `mainnet-internal` network only), `env_file: /run/agent-stack-mainnet/eth-rpc.env`, `restart: unless-stopped`, memory limit from the operator's numbers, healthcheck = `eth_chainId` returns `0x190f1b43`. Confirm the env substitution path: compose expands `${…}` in `command` from the compose process's environment, not from `env_file`; if so, use an `entrypoint` shell that reads the variable, and make sure the URL never appears in `docker inspect`-visible `command` output as a literal (it will appear in the container's environment, which is acceptable inside the stack and is the same exposure as every other rendered secret).
- Backend template: `RPC_BACKUP_URLS=http://mainnet-eth-rpc:8545,https://blockscout.polkadot.io/api/eth-rpc`. Indexer template: `RPC_BACKUP_URLS=http://mainnet-eth-rpc:8545`; `depends_on` the sidecar with `condition: service_healthy` for the indexer only.
- Tests: compose has the service with a digest-pinned image, no published ports, the internal network only (*mutation: add `ports:`*); the render loop covers three runtimes (*mutation: drop eth-rpc*); the backend template's backup list has the sidecar before Blockscout and the indexer's contains no Blockscout (*mutations: reorder; add*).

### Caveat that decides the next step

`--eth-pruning 100000` keeps the latest 100,000 blocks (about a week) in memory. For older ranges the adapter answers with fewer logs than Parity, and the indexer's cross-check will log "`http://mainnet-eth-rpc:8545` omitted N log(s) … report this block hole" on every historical range — which happens on every indexer deploy, because a deploy rotates the schema and re-backfills from the contract start block. The superset rule keeps the index correct; the noise is the cost. Two ways out, decided after one week of pilot numbers:

- **B2 (small code):** let a provider declare a head window (for example `RPC_BACKUP_URLS=http://mainnet-eth-rpc:8545|window=100000`) and have `crossCheckLogs`/`crossCheckBlocks` skip providers for ranges below `head − window`, with a test. Cheap, keeps memory bounded.
- **Archive mode:** `--eth-pruning archive` with a persistent volume. The adapter then walks 21.5 M blocks backwards through Dwellir's node: at the free tier's 20 RPS that is weeks and probably a paid plan; disk is the receipt database for the whole chain. Choose this only if the pilot shows the adapter is otherwise sound and the numbers are acceptable.

### Exit condition

1. Sidecar healthy for 7 days; its `eth_blockNumber` within 2 blocks of `eth-rpc.polkadot.io` on each hosted-smoke run (add that one check).
2. Backend failover counters show the sidecar answering when hedged to; Blockscout 429 count stays at zero or near it.
3. Indexer cross-check warnings attributable to the window are either tolerable or removed by B2.
Abort is one revert: remove the service and the two `RPC_BACKUP_URLS` edits; nothing else depends on it.

## Out of scope, with the reason

- Swapping the public `wss://asset-hub-polkadot-rpc.n.dwellir.com` Substrate reads (BANK_XCM, lane feed) to the keyed Dwellir endpoint: same key, separate change, after the pilot.
- A Blockscout API key to raise the 500/window budget: unverified whether the `/api/eth-rpc` route honours one; only worth testing if Track 1's 24-hour counters show 429s.
- The transparency reader's labelling and "no read" (QA packet, PR 2).

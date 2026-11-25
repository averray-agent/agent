# Packet: release 29.20 USDC held by stale open jobs (signer cleanup, November 2026)

**DIRECTIVE (implementer: Codex):** build this in `averray-agent/agent` as
**one PR** from a fresh worktree off `origin/main`. Do not review or
summarise the packet; implement it. Claude gates it before merge. Each guard
under "Acceptance" needs a test that goes RED when the guard is removed.

- **Approval:** Pascal approved writing this on 2026-11-25. Every on-chain
  run is started by Pascal, one batch at a time, after a Claude-gated dry run.
- **Scope:** bucket A (`cancelOpenJob`) only. No contract change.

## Why (chain reads, block 23588197, 2026-11-25 12:26Z)

- The bank position of `0x5a6836…5813` has 80.65 USDC reserved.
- 48 signer-posted EscrowCore v3 jobs are `Open` and hold 30.20 USDC. All 48
  `cancelOpenJob` calls pass `eth_call` from the signer. 32 were claimed at
  least once and reopened; 16 were never claimed.
- None of the 48 matches one of the 31 ids in the public `GET /jobs` list
  that day (compared as `keccak256(id)`, mapping verified on a known job).
- This packet takes the **47 jobs aged 14 days or more: 29.20 USDC**. The one
  younger job (`0xc745ff84…`, 1.00 USDC, 7 days) stays out.
- These figures go stale. The dry run is the source of truth, not this list.

## Behaviour

1. **Three manifests**, `scripts/ops/signer-cleanup-2026-11-{1,2,3}.json`,
   schema `averray.signer-cleanup.v1`, rows exactly as listed below: bucket
   `A`, escrow `v3`, function `cancelOpenJob`. No other buckets. Set
   `rescueJobIds: []`, and make `rescueCommands` print nothing for an empty
   list. The October manifest stays unchanged.
2. **Manifest selection.** `signer-cleanup.mjs` hard-codes
   `signer-cleanup-2026-10.json`. Add a required `--manifest <key>` resolved
   through a frozen map of allowed keys to file names (never a path), and a
   matching `choice` input on `hosted-signer-cleanup.yml`. Pass it through
   `run-signer-cleanup-host.sh`. No default: a run without a key fails.
3. **Bind the plan hash to the manifest.** Include the manifest key and the
   SHA-256 of the manifest file in `planHash`, so a hash reviewed for one
   batch cannot commit another.
4. **Everything else stays as it is:** the DENYLIST, retirement requirement,
   pre-state check, per-row simulation, nonce check, 14-minute window, and
   the host watchdog.
5. **Do not weaken `persisted_catalogue_retirement_required`.** A cancelled
   chain job id is terminal: `ensureJob` returns the existing job whenever
   its state is not 0, so a listing that is still live would point at a dead
   job. Jobs without a paused or archived record must stay blocked.
6. **Report the blocked ones usefully.** For each row blocked on retirement,
   the dry run also prints the catalogue id when a stored record or session
   resolves to that chain id, otherwise `catalogueId: "not reported"`.
   Absence must never count as retired. Read only.

If the dry run shows jobs that have no catalogue record at all, **stop and
report the count**. Do not add a write path for them in this PR. Claude and
Pascal decide that separately.

## Name the consumers (list them in the PR body)

Callers of `signer-cleanup.mjs`, `run-signer-cleanup-host.sh` and
`hosted-signer-cleanup.yml`; the tests that pin the manifest name or the plan
hash; and any runbook quoting the old invocation.

## Acceptance (each RED when its guard is removed)

- No `--manifest`, an unknown key, or a path-like key is refused before any
  RPC or KMS call.
- A plan hash from batch 1 is refused when committing batch 2.
- Editing a manifest after the dry run changes the hash and refuses the commit.
- A row with no retirement record is blocked; an absent record is not treated
  as retired.
- A job that became `Claimed` between dry run and commit is skipped and not
  sent.
- A job id on the DENYLIST is refused in every new manifest.
- Each new manifest has only bucket A rows on v3, with no id in two manifests
  and none shared with the October manifest.
- The October manifest file is byte-identical to main.
- An empty `rescueJobIds` prints no rescue command.

## After merge (operator)

1. Archive the listed jobs that the dry run can name, through
   `POST /admin/jobs/lifecycle` (Claude prepares the calls, Pascal runs them).
2. For each batch: dry run, Claude checks the plan and hash, then Pascal
   commits. **Every commit stops the backend for up to 15 minutes**, so run
   batches at a quiet time.
3. After each batch Claude reads the chain: rows `Cancelled`, and the bank's
   liquid up and reserved down by the same amount.

## Job list

### Batch 1: 16 jobs, 4.30 USDC

| jobId | USDC | age (d) | claims |
|---|---:|---:|---:|
| `0xad0244a943c79d0f744802d216f9168adad651e6f9a211b76acc010c8957b132` | 0.4 | 100.7 | 1 |
| `0xa4b8e4abcf9f646894717a7259d5b14a9e1a6c3ae6c1d6f8bf80feb6afcb4db0` | 0.1 | 97.1 | 1 |
| `0x412ad72471da6d9cf539aaa22b70aa11995b8a6e3f8996f32a40f589b3b74e3b` | 0.4 | 96.9 | 1 |
| `0xfd5f154b9edc18e869b4d248719ffc336f40d26272c58c733596307df4f177a6` | 0.1 | 96.9 | 0 |
| `0xd74c2453d407704c230173cd1657d7924630222773bb0bca99c9b30adeb3d254` | 0.4 | 96.8 | 1 |
| `0x19b5b74710c2be507c03738746694be946f2d2f139d97e6baf156c27b54030e1` | 0.1 | 95.9 | 0 |
| `0xb48d2f5873378facbf3b263842a6470b4fb591c952f2ca9ed068c28e2040f738` | 0.2 | 95.4 | 1 |
| `0x049c8f6c1eb60799c46d660e54cdaf39c955ca783f90cb2e57c477003933b241` | 0.4 | 94.1 | 1 |
| `0x37e4e4247b1a0a3f09480bb04d32ad740f1d1222f93dc426f57bc1be087d768d` | 0.4 | 93.8 | 0 |
| `0x8d5f4cfc93b5c9e2583a24636cc629a92972024f426090d9d1ec1c118aefe310` | 0.2 | 93.7 | 0 |
| `0xda264ff1fb0dfd527eb4dfd2f92494d669890bcdf177f8fc695d0991a62c632b` | 0.2 | 93.6 | 1 |
| `0x10a61d95813fb552bafba29ce1c70e79e7d707ae8c3e0f7a7ef6462295feb1e7` | 0.2 | 86.7 | 0 |
| `0x36aa730663404ff8e2a254107a627179dd4740c4011a80b440e0a3fe30d2771d` | 0.4 | 86.7 | 0 |
| `0x4c73162d6dbf9e977122c68de9e9e98861c325f30a4e94ab65f7ac9323a5e5da` | 0.4 | 86.7 | 0 |
| `0x7496b0309bbc8cdb9cbedabce7ea95c323c2b209a14cc4fb9c9471364d8d2c56` | 0.2 | 82.9 | 1 |
| `0x351f3e7e5bb2564204e7c60f7418aabe36df8bacc762fd7108794e1b1bad652a` | 0.2 | 77.9 | 1 |

### Batch 2: 16 jobs, 9.90 USDC

| jobId | USDC | age (d) | claims |
|---|---:|---:|---:|
| `0x9c43fdeb1c7a808ead53eb929f4ca87dcfa39a3093e63c63041f72f39217eba3` | 0.1 | 75 | 0 |
| `0x4b3a62fef63cee36ed3e7f170d9b473b20957d333f016201180185b2d339c7a8` | 0.1 | 73.5 | 0 |
| `0xe3ea16fdfee3fac14a84190eac0f435ff74f7b11b84dee7cf7b52ba512ba1e20` | 0.1 | 71 | 0 |
| `0xbe7f0cf21104d2647298afce5556fb8906cbe7dbdf7dc6994db0ec769c36b272` | 0.1 | 70.7 | 0 |
| `0xb72fde56939464b7908c8443c5a2a4d5b9a3aa888ccdc20bbc0ee857f358dffb` | 2.1 | 70.5 | 0 |
| `0xb352351314e8033ff54292e2278f4a003eb27bdf3e642741dec90ddddf8ffeb2` | 1 | 70.4 | 0 |
| `0x9074397eab1a91aace3f3cbb7a6630e7e02d21da3f4e36cf1a9769d1a4e2d7af` | 0.1 | 68 | 0 |
| `0xfd57b369f9d1892e5762f89ee53e9b4b6a02850dd308123ff6969f5edff8a8d6` | 0.1 | 67 | 0 |
| `0xf255477534168b553ff3a42643717c73488ab5e59abe26f07434cfeade95acd8` | 0.1 | 66 | 0 |
| `0x509d240bda550fd298dac6848b968d3b038037afc7eadb82dc324e22879b74bf` | 0.1 | 60 | 1 |
| `0x6e8e1799826a216d99cdde0e910c383d22e9dddbaa8a731acbef9c15daf5ca23` | 1 | 47.7 | 1 |
| `0x9c811de48144ac6e01684a219ddfb1b57593ac75c551d623601a9239fb59a754` | 1 | 46.2 | 1 |
| `0xe69282730da10a4754e28e5d1fb1b6282008f6c5a16892c228a0d78b4002dccd` | 1 | 44 | 1 |
| `0x0b86337c0e378a9defbb7a8d2fcf3e3516a1be51bb9630b42f1e4436e2063c74` | 1 | 43.8 | 1 |
| `0x74c063dd4c36239a12ea94a87aff92ba7f19ccaf3be7384cbe61db9777296b15` | 1 | 43.6 | 1 |
| `0x89045b1410f284de611331cb246cea29e11d62197f6efc7d9b37137f5846cd88` | 1 | 42.3 | 1 |

### Batch 3: 15 jobs, 15.00 USDC

| jobId | USDC | age (d) | claims |
|---|---:|---:|---:|
| `0xb2d9027f07fc1149c5c72f88bb4ac5ce0d35d54b310b5521d288bf266f0a1e58` | 1 | 34.3 | 1 |
| `0xc0beca19264696bd4f09a7e12c4b43a00c9cf7211f9ce734717eb732fdd41d49` | 1 | 34.2 | 1 |
| `0x98f48e8c20d342867838d31f7d6ca98b78db17f87a76491082cd717ced401ab9` | 1 | 30.2 | 1 |
| `0x19ffe4bc4899c4343342df4eec75921432f23091fcb8099a888a00993a4d302d` | 1 | 16.9 | 1 |
| `0x210926c6e38385f9df2d824d88a3d7c39ad308e511d9ed997adb85967e2347c9` | 1 | 16.9 | 1 |
| `0x2f662ec3f7376445c496dabecbc08cef1bc289fd0ecea9c35e351d5ba1f6fe29` | 1 | 16.9 | 1 |
| `0x68b53ec26754a7a34f857b1601c259c42a4d139705635906e66a60344a94a564` | 1 | 16.9 | 1 |
| `0xb8eb9dce8084e335a33a4e0d4234a58c1de6c0b5bf3c1c6b2fe760ddc7dc77a4` | 1 | 16.9 | 1 |
| `0xbe2c796505fa5794240e34c4e40353fdcf1a3bbbf040d56b9939606d2d379a56` | 1 | 16.9 | 1 |
| `0xe513d79bc173ab93a3d001d9c07e7399ce6722552dcd263b66e3514999ba3883` | 1 | 16.9 | 1 |
| `0x08f9c69876e6bb3811b8166674dc169a56527cf3977b3d46ab1c70020d1a50a2` | 1 | 16.8 | 1 |
| `0x2f81b289e84ac9e76ec9afae21558d96177d273d5046149bdedb289025fe02d8` | 1 | 16.8 | 1 |
| `0xa4d600e53e9b1897e2df1a1a585a3f81fc2523aebee02883f61f8363b0f5edf5` | 1 | 16.8 | 1 |
| `0xdc181559b222f8c906622dfba5dc4860aa3cc79c6f5ac44e28dbe988a6980189` | 1 | 16.8 | 1 |
| `0xde962596954d42601e35dc71e517f233f53058c713a55fb8940cbe9c4869b15b` | 1 | 16.7 | 1 |

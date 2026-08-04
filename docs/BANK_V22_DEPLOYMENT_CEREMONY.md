# Bank v2.2 G2 deployment ceremony

Status: **unsigned preparation only**. This runbook implements G2 from
`BANK_V22_BUILD_PACKET.md`. It does not authorize a deployment or a multisig
signature. G3 live leg preflights and the arm ceremony remain separate.

## 1. Scope and hard stops

G2 has three state-changing moments, each separately gated:

1. deploy `XcmWrapperV22`, then `HydrationUsdcAdapterV22`;
2. configure the paused wrapper through the owner multisig;
3. fund the new wrapper image with exactly **0.30 DOT** postage.

The deployer sends only the two CREATE transactions. The configure batch has
exactly four calls and contains no `setDispatchPaused(false)`. The new pair must
remain paused and `BANK_XCM_FLOW_ENABLED=false` throughout G2. Do not emit or
sign arm material until G3 has produced four live, limit-aware per-leg
preflights through the deployed contract.

Stop before signing if any of these is true:

- the checkout is dirty, `HEAD != --source-commit`, or the source commit is not
  reachable from `origin/main`;
- the forced build changes either reviewed creation hash;
- the deployer has less than the fresh two-contract estimate plus 20%;
- pending nonce or predicted address changes after review;
- the live v2.2 selector probe does not return a non-zero bytes32;
- either deployment is not paused/unconfigured, or its immutable/state reads
  differ from the manifest;
- the two independent `convert_location` reads disagree;
- the same-flow manifest/env record fails, produces other than four wrapper
  candidates, or enables the Bank flow;
- any configure call is not one of the four listed in section 5, or any unpause
  selector appears.

## 2. Reviewed build facts

The deploy script force-runs `forge build --skip test --force` and compares the
result to these constants before it can prompt:

| Contract | Creation hash | Runtime hash (compiled) | ABI hash |
| --- | --- | --- | --- |
| `XcmWrapperV22` | `sha256:900a719c2fe6b41db8e3bc154177b044f6c9bc8e950387aff592a16f6214a086` | `sha256:68f61e655e0c7b6a8c702094cf9e77f2d911427521df63d4552cce1f9a9e747a` | `sha256:1a3837c645acb5500fd740c70617c8c1c8dbf9d80c7df0d0b17fab55bfcc666b` |
| `HydrationUsdcAdapterV22` | `sha256:b1ce42c403163d7e06f4e12e4d6177f21634c1053eb0d6ef2cb60135c986dc99` | `sha256:901262e184efcae35de71777c857288f9d01bd891203e9f63eb372aafffb14c4` | `sha256:938a8cf6e9ebeec2ec6c038ad610a0557a7e8179680f5acedc38c2c076156709` |

The external version fact is
`previewRecoveryHomeId(bytes32,uint256,uint64)`, selector `0x526a213a`.
Post-deploy verification calls that selector against the live wrapper and
requires a non-zero 32-byte response. Artifact/runtime equality alone is not a
version proof.

## 3. Merge-first preview and deployer funding gate

The ceremony code must merge first so `contractProvenance.sourceCommit` is a
reachable main commit. Create a clean record branch at that exact commit; the
successful deploy will deliberately dirty it with evidence, manifest, and env
files for the paired record PR.

```sh
./scripts/ops/sync-local-main.sh
./scripts/ops/start-agent-worktree.sh codex/bank-v22-g2-live-record
cd <printed-worktree>
SOURCE_COMMIT=$(git rev-parse HEAD)

node scripts/ops/deploy-bank-xcm-v2.mjs \
  --profile mainnet \
  --expected-deployer 0x9Ab8531FBb0948C542a31298FD61335f30064239 \
  --source-commit "$SOURCE_COMMIT" \
  --replace-existing \
  --bundle-out /tmp/bank-v22-g2-deploy-preview.json
```

This is read-only. Claude checks the complete preview and Pascal authorizes the
two CREATE transactions separately.

The funding rule is exact and fail-closed:

```text
requiredWei = (fresh wrapper estimate + fresh adapter estimate)
              * fresh gas price * 1.20
commit allowed iff deployer balanceWei >= requiredWei
```

The packet input mentioned 3.644 DOT. A capture-time read on 2026-08-04 at
Asset Hub block 19,059,538 instead observed **5.1442856 DOT**, pending nonce 7.
The provisional estimate was 3.7820432 DOT and the 20% floor 4.53845184 DOT, so
that snapshot passed. It is not reusable: the guarded preview must re-read all
four values in the signing session.

At that snapshot the provisional CREATE pair was:

- wrapper: `0xEceE778e11B238D2fc096E56460e7B98DC7B26b8` (nonce 7)
- adapter: `0x631A09913B2403B18b2B659a1397916621b29b4c` (nonce 8)

Any nonce change invalidates both addresses, the conversion preview, configure
calldata, and postage address. Regenerate; never edit them by hand.

## 4. Authorized deploy command and same-flow record

Only after the read-only preview is independently gated:

```sh
mkdir -p docs/evidence

node scripts/ops/deploy-bank-xcm-v2.mjs \
  --profile mainnet \
  --expected-deployer 0x9Ab8531FBb0948C542a31298FD61335f30064239 \
  --source-commit "$SOURCE_COMMIT" \
  --replace-existing \
  --bundle-out /tmp/bank-v22-g2-deploy-commit-plan.json \
  --deployment-evidence-out docs/evidence/mainnet-bank-xcm-v22-deployment-YYYY-MM-DD.json \
  --conversion-evidence-out docs/evidence/mainnet-bank-xcm-v22-conversion-YYYY-MM-DD.json \
  --signer-secret-ref 'op://mainnet-critical/admin-eoa-mainnet/credential' \
  --commit
```

The concealed key is resolved only after all guards and the typed confirmation.
The typed string binds both predicted addresses:

```text
DEPLOY BANK XCM V2.2 AND RECORD <WRAPPER> <ADAPTER>
```

After both successful receipts the same process must, before printing green:

1. compare both live runtimes outside immutable slots;
2. execute the hard-coded `0x526a213a` selector probe;
3. re-read `dispatchPaused=true`, zero operator, zero converted account, and all
   constructor bindings at a stamped live block;
4. derive the wrapper origin with two independent Hydration
   `LocationToAccountApi.convert_location` calls and write create-only evidence;
5. re-verify receipts/runtime while constructing the manifest candidate;
6. append v2.2 to `bankXcmDeploymentHistory`, write the new provenance/blocks,
   and repoint the current pair;
7. render `deploy/backend.mainnet.env.template`,
   `deploy/indexer.mainnet.env.template`, and `deploy/secrets-inventory.md` from
   that candidate;
8. assert the backend env has exactly four history candidates and still says
   `BANK_XCM_FLOW_ENABLED=false`.

There is no path that prints `RECORDED PAUSED` before all eight complete. If a
post-CREATE record step fails, the command exits red: do not redeploy. Preserve
the receipts/evidence and repair the paired record on the same branch.

The resulting PR must contain the two evidence files plus the paired manifest
and generated env/inventory diff. It must say: contracts and config subject
changed; runtime flow remains disabled; configure/arm are not deployed by the
normal production pipeline.

Use this PR body skeleton (replace every bracket from captured evidence):

```markdown
## What changed
- recorded XcmWrapperV22 [address], tx [hash], block [number]
- recorded HydrationUsdcAdapterV22 [address], tx [hash], block [number]
- two-endpoint conversion matched [accountId32]
- repointed manifest/env observer subject; wrapper candidate count is 4

## Live proof
- source commit [full reachable commit]; forced build hashes matched
- wrapper selector 0x526a213a returned [bytes32]
- wrapper paused/unconfigured at block [number]
- BANK_XCM_FLOW_ENABLED=false; no arm/unpause call

## Checks
- [tests]

## Surface
Contracts + manifest/backend/indexer env records only. No production flow
activation; no ordinary deploy pipeline contract write; no new secret.
```

## 5. Conversion and paused configure packet

Conversion evidence uses two current, independent Hydration HTTP providers:

- `https://rpc.kril.hydration.cloud`
- `https://rpc-catfish-1.catfish.hydration.cloud`

Both must report the Hydration genesis
`0xafdc188f45c71dacbaa0b62e16a91f726c7b8699a9748cdf715459de6b7f366d`
and the same AccountId32. HTTP is intentional for these one-shot runtime API
reads; it avoids treating a public WebSocket 1006 as chain failure.

After deployment and after the paired manifest has been generated, emit the
unsigned first leg:

```sh
node scripts/ops/prepare-bank-xcm-v2-multisig.mjs \
  --profile mainnet \
  --generation 2.2 \
  --packet configure \
  --wrapper <LIVE_WRAPPER> \
  --adapter <LIVE_ADAPTER> \
  --converted-account <TWO_ENDPOINT_ACCOUNT_ID32> \
  --conversion-evidence docs/evidence/mainnet-bank-xcm-v22-conversion-YYYY-MM-DD.json \
  --signer nova \
  --packet-out docs/evidence/mainnet-bank-xcm-v22-configure-leg1-YYYY-MM-DD.json
```

The generator re-reads live policy ownership and the new contracts at capture
time, checks Polkadot Asset Hub metadata (revive pallet 90), embeds each EVM
calldata in SCALE, and writes the unsigned packet create-only with a `liveState`
stamp. The four calls, in order, are:

1. wrapper `setHydrationAccountId32(convertedAccountId32)`;
2. wrapper `setOperator(0x5a6836c6D4d293F6E5377E6c28054F4171915813)`;
3. wrapper `setStrategyAdapter(HYDRATION_USDC_V1, adapter)`;
4. TreasuryPolicy `setStrategySettler(operator, true)`.

There is no `setDispatchPaused(false)`. The v2.2 emitter rejects `--packet arm`,
`--dry-run-evidence`, or `--messages-out` during G2.

For orientation only, the nonce-7 provisional pair produced converted account
`0x42e55ecf123da7d3eba1c55998b3cbf8238c446367c981f1388acbc0626cf354`
on both endpoints and configure inner-call hash
`0x1d5b87fd1cfaf5daa77d37e233b9f89448ef0563d3c613af575816b82b9c73f1`.
These values are **not signable** until the deployed addresses and fresh
conversion evidence reproduce them.

Pascal signs leg 1 in Nova/Spektr. Capture `multisig.NewMultisig` timepoint and
re-run the same emitter with another attested signer plus
`--timepoint-height/--timepoint-index`. The call hash must be identical. After
`MultisigExecuted(Ok)`, re-read all four configured values and prove
`dispatchPaused=true` at a fresh block.

## 6. Observer targets and exact postage

The same-flow manifest/env repoint declares, while disabled:

- asset 22: `Tokens.accounts(convertedAccountId32, 22)` via the configured
  Hydration Substrate observer endpoint;
- aUSDC: `balanceOf(truncate20(convertedAccountId32))` on
  `0x2ec4884088d84e5c2970a034732e5209b0acfa93` via
  `https://rpc.hydradx.cloud`;
- wrapper candidates: all three retired/abandoned generations plus the new
  v2.2 wrapper as candidate four.

Fund postage only after the live selector probe succeeds. Transfer exactly
**0.30 DOT (3,000,000,000 planck)** on Asset Hub to the new wrapper image
`AccountId32(wrapperH160 || 0xEE × 12)`, SS58 prefix 0. Verify the receiving
`System.Account` balance at a fresh block and record tx hash/block/source.

For the nonce-7 provisional wrapper only, that image is:

- AccountId32:
  `0xecee778e11b238d2fc096e56460e7b98dc7b26b8eeeeeeeeeeeeeeeeeeeeeeee`
- SS58: `16Mf98wAbYTVWaeHkD1SUdRPc5nmoLj9LyNtPtP1xvkF7Sxb`

If the actual wrapper differs, the deploy preview prints the replacement SS58.
Never fund a provisional image after an address change.

## 7. G2 close and G3 barrier

G2 is complete only when the deploy receipts, selector response, two conversion
reads, same-flow record/env diff, configure execution result, paused/configured
live reads, and postage receipt are all captured. The evidence uses capture-time
state; skeleton/default `liveState` values are forbidden.

Then stop. G3 must independently run all four per-leg, limit-aware
`ReviveApi_call` preflights through the deployed v2.2 wrapper on live state with
fresh fee quotes. Only a separate gated arm packet may unpause it.

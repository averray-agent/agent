# Bank v2.2.1 G2 deployment and succession ceremony

Status: **unsigned preparation only**. This packet prepares the v2.2.1 pair
introduced by `BANK_V22_BUILD_PACKET.md`. It authorizes no CREATE transaction,
multisig approval, postage transfer, configuration call, or arm call.

## 1. Hard stops

- Run the guarded preview only from a clean checkout whose `HEAD` equals the
  full `--source-commit`, and require that commit to be reachable from
  `origin/main`.
- The deploy runner force-builds Foundry artifacts. Refuse if the v2.2.1
  creation hashes differ from section 2.
- Require deployer balance at least the fresh two-contract estimate plus 20%.
- Any pending-nonce change invalidates both CREATE addresses, conversion,
  configuration calldata, postage image, and every downstream hash. Regenerate
  all of them; never hand-edit.
- Both deployments must be paused/unconfigured, match their reviewed runtime
  outside immutable slots, and answer the external v2.2.1 selector probe.
- The two independent Hydration `convert_location` reads must match.
- The deploy cannot exit green until the same process has appended v2.2.1 as
  candidate five, repointed the paired manifest/env render, and kept
  `BANK_XCM_FLOW_ENABLED=false`.
- Configure contains exactly four calls and no pause transition.
- Succession contains exactly two calls in order: pause v2.2, then arm v2.2.1.
  Never sign two independent pause/arm transactions.

## 2. Reviewed artifact and version facts

The forced build at merged contracts commit
`c062d58fa6f7594f1039f91ab1aced4c38727b7c` produced:

| Contract | Creation hash | Compiled runtime hash | ABI hash |
| --- | --- | --- | --- |
| `XcmWrapperV22` (v2.2.1 source) | `sha256:510252af64add49682fc6f5f6c3a91d798d15a58cae5dcc19907f5a0ce6d4891` | `sha256:162894633ea265a42353848e103d0982cac050dacbf33e83756181dff612a960` | `sha256:abe3801f2f88c09eca5d433345a0233063e4bdd7afa8b51dc00ab80dc6bdd004` |
| `HydrationUsdcAdapterV22` | `sha256:8d1b17faacdc1c2f01b7fdcfdd88a8c3f412c04ed578b32b9a184be1b94551d3` | `sha256:f1e3236431f7d2c1539f516aac048b28d394fa92a6c75dfae67ee952eef5858c` | `sha256:938a8cf6e9ebeec2ec6c038ad610a0557a7e8179680f5acedc38c2c076156709` |

The external version fact is
`previewRecoveryHomeId(bytes32,uint256,uint256,uint64)`, selector
`0x56112922`. The post-deploy check calls it with fixed non-zero probe inputs and
requires a non-zero bytes32 response. Artifact equality alone is not accepted.

## 3. Reachable-main preview and funding gate

Merge this ceremony tooling first. From a fresh worktree at the resulting
reachable main commit:

```sh
SOURCE_COMMIT=<full git rev-parse HEAD>

node scripts/ops/deploy-bank-xcm-v2.mjs \
  --profile mainnet \
  --expected-deployer 0x9Ab8531FBb0948C542a31298FD61335f30064239 \
  --source-commit "$SOURCE_COMMIT" \
  --replace-existing \
  --bundle-out /tmp/bank-v221-g2-deploy-preview.json
```

This command is read-only without `--commit`. Record the fresh pending nonce,
predicted pair, artifact hashes, deployer balance, estimate, and 20% floor. The
funding condition is exact:

```text
requiredWei = freshEstimatedWei * 1.20
commit allowed iff deployerBalanceWei >= requiredWei
```

The deployer spent nonce 7/8 on v2.2, so no old balance, nonce, predicted
address, conversion, or configure hash is reusable.

## 4. Guarded deploy and same-flow record

Only after independent review of the fresh preview may Pascal authorize the
same command with `--commit`, a concealed signer reference, and create-only
deployment/conversion evidence paths. The exact typed string is:

```text
DEPLOY BANK XCM V2.2.1 AND RECORD <WRAPPER> <ADAPTER>
```

Before printing green, the runner must:

1. confirm both successful receipts at the predicted CREATE addresses;
2. compare live runtime code outside immutable slots;
3. execute selector `0x56112922` against the live wrapper;
4. prove paused/unconfigured constructor state;
5. capture matching conversion results from two independent Hydration endpoints;
6. append version `2.2.1` to `bankXcmDeploymentHistory` as entry five;
7. record provenance/blocks/deployer and repoint manifest/env in the same flow;
8. assert the rendered candidate list contains five wrappers and the flow stays disabled.

No ordinary production deploy creates these contracts.

## 5. Conversion and four-call configure packet

For the final predicted or deployed wrapper, capture two-endpoint conversion:

```sh
node scripts/ops/capture-hydration-wrapper-origin.mjs \
  --wrapper <V221_WRAPPER> \
  --out /tmp/bank-v221-conversion.json
```

Both endpoints must return the same Hydration AccountId32. Then emit unsigned
configuration material (Nova is the proposed first leg; regenerate if Pascal
chooses another attested signer):

```sh
node scripts/ops/prepare-bank-xcm-v2-multisig.mjs \
  --profile mainnet \
  --generation 2.2.1 \
  --packet configure \
  --wrapper <V221_WRAPPER> \
  --adapter <V221_ADAPTER> \
  --converted-account <CONVERTED_ACCOUNT_ID32> \
  --conversion-evidence /tmp/bank-v221-conversion.json \
  --predeploy-plan /tmp/bank-v221-g2-deploy-preview.json \
  --signer nova \
  --packet-out /tmp/bank-v221-configure-leg1.json
```

The four inner calls are, in order:

1. v2.2.1 wrapper `setHydrationAccountId32(converted)`;
2. v2.2.1 wrapper `setOperator(backendSigner)`;
3. v2.2.1 wrapper `setStrategyAdapter(HYDRATION_USDC_V1, adapter)`;
4. TreasuryPolicy `setStrategySettler(backendSigner, true)`.

The packet contains no pause or unpause call. After execution, re-read all four
values and prove the candidate remains `dispatchPaused=true`.

## 6. Exact postage instruction

Only after the live selector check succeeds, transfer exactly **0.30 DOT
(3,000,000,000 planck)** on Asset Hub to the final wrapper image:

```text
AccountId32 = lower(wrapper H160) || 0xEE * 12
SS58        = preview.wrapper.postage.ss58
```

Use only the AccountId32/SS58 printed by the fresh final preview. Record source,
tx hash, block, and a post-transfer `System.Account` read. Never fund a
provisional image after a nonce change.

## 7. Atomic succession packet and its emission basis

The unsigned succession shape is fixed:

1. old v2.2 `0xEceE778e11B238D2fc096E56460e7B98DC7B26b8`
   `setDispatchPaused(true)`;
2. new v2.2.1 wrapper `setDispatchPaused(false)`.

Both calls are inside one `utility.batchAll`/multisig payload. The emitter
requires all three of the following at capture time:

1. the v2.2.1 G2 verification bundle: live runtime hashes, external selector
   probe, and configured-paused post-state;
2. a chain-fresh armed-empty statement: no `RequestQueued` events, zero adapter
   accounting/custody/allowance, the exact adapter/operator bindings, old v2.2
   still armed, candidate paused, and the production flow disabled;
3. one live, request-independent three-hop dry-run of the corrected v2.2.1 home
   shape. The evidence must be byte-equal to the reviewed builder, use a
   dispatch-priced nested fee strictly below the quoted amount arriving at the
   Asset Hub hop, complete on Hydration, forward to para 1000, and prove the
   final asset-1337 deposit to the candidate wrapper image on Asset Hub.

The third proof uses a diagnostic `SetTopic` only; it creates no request and
does not confer authority. The emitter reconstructs the message from the
recorded amount, fee, topic, and candidate wrapper, then compares those bytes
and their hash to the bytes passed to both dry-run hops. Fork or fabricated
state is not accepted.

The create-only evidence file uses
`kind=averray.bankXcmV221RequestIndependentHomeProof`, `version=2.2.1`, and
`requestIndependent=true`. It records both live block heights, the gross
amount, upstream fees and quoted arrival, the quote timestamp, the builder
topic/fee/message/hash, the identical dry-run message/hash, Hydration
completion, forwarding to para 1000, and the final Asset Hub
`Assets.Deposited` asset/account/amount. The validator requires
`quotedArrivalRaw = grossAmountRaw - upstreamFeesRaw` and
`0 < homeExecutionFeeRaw < quotedArrivalRaw`.

Request-bound per-leg certification is deliberately **not** a pre-arm gate.
After succession, every real dispatch still requires its just-in-time live
preflight and fresh fee quote under the standing dispatcher rules.

After the three emission-basis records exist, run:

```sh
node scripts/ops/prepare-bank-xcm-v2-multisig.mjs \
  --profile mainnet \
  --generation 2.2.1 \
  --packet arm \
  --previous-wrapper 0xEceE778e11B238D2fc096E56460e7B98DC7B26b8 \
  --wrapper <V221_WRAPPER> \
  --adapter <V221_ADAPTER> \
  --converted-account <CONVERTED_ACCOUNT_ID32> \
  --conversion-evidence <TWO_ENDPOINT_EVIDENCE> \
  --deployment-evidence <G2_DEPLOYMENT_EVIDENCE> \
  --home-dry-run-evidence <REQUEST_INDEPENDENT_HOME_PROOF> \
  --signer nova \
  --packet-out /tmp/bank-v221-succession-leg1.json
```

No signature is valid unless independent byte review confirms exactly the two
pause transitions, in order, and the candidate's live three-hop home proof
completed. This packet never contains configuration, request, or capital calls.

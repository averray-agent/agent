# PACKET — Make the venue ceremony able to sign on mainnet

Status: READY FOR CODEX · 2026-08-28 · Author: Claude (architect+gate) ·
Repo: **platform, scripts** · One PR. **No contract changes, no economics.**
Blocks: `RUNSHEET_VENUE_MEASUREMENT.md`, which is otherwise ready to execute
(step 0 clear, fee window open at 18,405 against a 26,000 ceiling, dry run
verified end to end).

## The defect

`scripts/ops/pool-venue-ceremony.mjs:290`:

```js
const signer = new KmsSigner({ keyId, region, provider });
```

**No `credentialsProvider`.** Mainnet KMS authenticates through AWS Roles
Anywhere via the named shared-config profile `averray-signer`
(`PROFILE_BLOCKCHAIN_SIGNER`); there are **no static access keys for mainnet by
design** — only `kms-key-id` and `aws-region` exist in 1Password for
`aws-signer-mainnet`. The SDK's default provider chain therefore resolves
nothing and `getAddress()` dies with *"Could not load credentials from any
providers."*

`gateway.js` already does this correctly:

```js
const credentialsProvider = buildKmsCredentialsProvider({ profile: PROFILE_BLOCKCHAIN_SIGNER });
return new KmsSigner({ region, keyId, provider, logger, credentialsProvider });
```

**Mirror that. Do not invent a different path.**

## The second half: it must run where the key is usable

The Roles Anywhere certificates live inside `agent-mainnet-backend`
(`/root/.aws/config`, `AWS_USE_ROLES_ANYWHERE=true`), not on the operator's
laptop. So the script has to be runnable in the container, and today it is not:
it imports `../../mcp-server/src/blockchain/kms-signer.js`, which the image
places at `/app/src/...` (see `mcp-server/Dockerfile`: `COPY mcp-server/src
./src`), plus a sibling `./ceremony-rpc.mjs`.

Resolve module paths against **both layouts** — the repo checkout and the
image — the way `scripts/ops/idle-consent-kms.mjs` already does. Keep the
sibling import working in both.

**Also confirm and state in the handback** how the script reaches
`deployments/mainnet.json` inside the container (the image copies it to
`/deployments/mainnet.json`, not a repo-relative path), and what
`--observability-url` should be from inside the container, where the operator's
SSH tunnel does not exist.

## Non-negotiables (each pinned by a test)

1. `--use-kms` builds a signer with the `averray-signer` credentials provider —
   asserted, not merely present.
2. Import resolution works in both layouts; a missing module in one produces a
   named error naming both attempted paths, never a bare MODULE_NOT_FOUND.
3. Every existing guard is untouched: `--pool` resolution and its logging, the
   `venue_adapter_not_bound` precondition, `assertObservability`, the
   signer-matches-operator check, fee gating, and dry-run-by-default.
4. Dry run still signs nothing and requests no credentials.
5. No change to deployment economics, staging, or the transaction built.

## Out of scope

Ceremony B, the measurement itself, contracts, and any change to what the
ceremony does — this PR only lets it authenticate where the key lives.

## Handback

PR number; green CI; the test names; the manifest and observability answers
above; and the **exact command** that runs a dry-run deploy against legacy v2
`0x6061f0aC…` from inside `agent-mainnet-backend`.

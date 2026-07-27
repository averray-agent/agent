# Mainnet zero-gap cutover

This runbook keeps the public domains on the healthy testnet stack while a
separate mainnet backend/indexer is built and proven on the same VPS. The only
public transition is a Caddy reload after every GO gate is green.

## Isolation contract

| Surface | Testnet (unchanged) | Mainnet sidecar |
| --- | --- | --- |
| Compose project | `agent-stack` | `agent-mainnet` |
| Backend | `agent-backend`, `127.0.0.1:8787` | `agent-mainnet-backend`, `127.0.0.1:18787` |
| Indexer | `agent-indexer`, `127.0.0.1:42069` | `agent-mainnet-indexer`, `127.0.0.1:52069` |
| Redis | `agent-redis` | dedicated `agent-mainnet-redis` on an internal-only network |
| Redis namespace | `agent-platform` | `agent-platform-mainnet` |
| Indexer database | current production DB/schema | dedicated `averray_mainnet` DB and fresh Ponder schema |
| AWS config/certs | `/etc/agent-stack` | `/etc/agent-stack-mainnet` |
| Runtime env | `/run/agent-stack` | `/run/agent-stack-mainnet` |

The signer profile names are intentionally identical inside each backend
container because the application hard-codes them. Isolation is provided by
mounting a different host config and certificate directory into the mainnet
container. Never append or replace mainnet sections in the live testnet AWS
config while both stacks run.

Only `mainnet-backend` and `mainnet-indexer` join `agent-stack_default`, with
unique DNS aliases so Caddy can reach them after the flip. Mainnet Redis never
joins that network.

## 1. Snapshot testnet

The database and Redis backups are captured by the hosted backup snapshot
workflow. Compose, Caddy, runtime envs, service-account envs, AWS config, and
Roles Anywhere material are captured as an encrypted archive:

```sh
op read 'op://prod-critical/cutover-snapshot-encryption-key/password' \
  | sudo /srv/agent-stack/app/scripts/ops/capture-cutover-config-snapshot.sh
```

The script never writes a plaintext archive. It decrypts into `/dev/shm`,
extracts, and byte-compares the snapshot against the live files before
reporting `restore_check=verified`. Keep the provider VM snapshot as the outer
rollback layer; `/run/agent-stack` is tmpfs and therefore still needs this
encrypted archive.

## 2. Complete the on-chain ceremony

Deploy contracts only from frozen tag `audit/mainnet-2026-07-07` (`fd9b306`).
Record the final 2-of-3 mapped owner in
`deployments/mainnet-multisig-owner.json`, then the deployed addresses and
ownership/role wiring in `deployments/mainnet.json`.

The launch record must keep `parameters.dailyOutflowCap` equal to
`type(uint256).max`
(`115792089237316195423570985008687907853269984665640564039457584007913129639935`).
A finite value self-DoSes settlement under audit-2 H-1, while `0` would reject
every metered outflow. The preflight requires the exact audited value, a
verified recorded mapping or verified runtime AutoMap record, and a deployment
owner matching the mapped multisig.

## 3. Render and preflight the mainnet runtime

Install the three mainnet certificate/key pairs under
`/etc/agent-stack-mainnet/roles-anywhere` as mode `0400 root:root` — the same for
both the certificate and the private key in every pair — and install
`deploy/aws-config.mainnet` as `/etc/agent-stack-mainnet/aws-config`. Render the
mainnet backend/indexer templates into `/run/agent-stack-mainnet` using the
scoped mainnet service-account tokens.

For the internal-only sidecar, the manifest deliberately uses the mapped owner
as `AUTH_ADMIN_WALLETS`. A native multisig cannot complete ordinary SIWE, so
this is fail-closed rather than an interactive admin login. Before smoke or
public GO, add the fresh dedicated mainnet SIWE admin from credentials-plan F15;
do not reuse the pauser or arbitrator hardware EOAs for routine admin auth.

Run:

```sh
sudo cp /srv/agent-stack/app/deploy/agent-stack.tmpfiles.conf \
  /etc/tmpfiles.d/agent-stack.conf
sudo systemd-tmpfiles --create

sudo /srv/agent-stack/app/scripts/ops/render-vps-env.sh \
  /srv/agent-stack/app/deploy/backend.mainnet.env.template \
  /run/agent-stack-mainnet/backend.env \
  /etc/agent-stack-mainnet/op-backend.env
sudo /srv/agent-stack/app/scripts/ops/render-vps-env.sh \
  /srv/agent-stack/app/deploy/indexer.mainnet.env.template \
  /run/agent-stack-mainnet/indexer.env \
  /etc/agent-stack-mainnet/op-indexer.env

sudo /srv/agent-stack/app/scripts/ops/preflight-mainnet-sidecar.sh
```

The sidecar preflight is an internal-runtime gate, not the public GO gate. It
may accept a verified AutoMap owner record that is still `status=draft`, but it
prints `owner_go_gate=pending` until the 2-of-3 ownership/admin rehearsal is
recorded and `launchGate.readyForOwnerUse=true`. The later release-readiness
gate must run with `REQUIRE_OWNER_RECORD_FINAL=1` (the default); do not disable
or waive it for GO.

The preflight checks certificate/key pairing, mode and ownership (`0400
root:root` for both cert and key; looser modes such as `0600`/`0644` are
rejected), expiry, exact AWS profiles,
absence of static AWS credentials, mainnet backend and indexer chain/RPC
identity, exact manifest-derived addresses/start blocks/schema, isolated Redis
and indexer DNS, completed contract/owner records, the audited unbounded
outflow-cap posture, valid compose, and health of all five live testnet
containers.

## 4. Start and prove mainnet internally

```sh
sudo /srv/agent-stack/app/scripts/ops/start-mainnet-sidecar.sh
```

The start script builds and starts only the `agent-mainnet` project, waits for
all three containers, requires internal backend health to report chain ID
`420420419`, and proves the testnet containers kept the same IDs and start
timestamps.

Before GO, require all four mainnet proof artifacts, at least three confirmed
claim → submit → verify → settle loops, and advancing mainnet indexer
checkpoints. The env/secrets proof must report
`staticAccessKeysRendered=false`, `rolesAnywhere=true`, and `multiRegion=true`.

## 5. Atomic public flip and rollback

Before the public flip:

- land the mainnet-capable Hosted Worker Canary retarget, then set
  `WORKER_CANARY_PROFILE=mainnet`. The current canary is deliberately
  testnet-only and rejects a mainnet profile, so changing the environment
  variable before that implementation lands is not sufficient;
- land and verify the queued arbitrator fail-closed packet.

Do not run this command until the GO gate is fully green:

```sh
sudo /srv/agent-stack/app/scripts/ops/flip-caddy-network.sh mainnet
```

The script checks the target internally, locks cutover operations, renders a
pure Caddy upstream state, preserves a timestamped Caddyfile, validates, and
reloads Caddy. It then requires public `/health` to report chain ID `420420419`.
Any validation, reload, or health failure restores and reloads the prior route.
Only after that assertion succeeds does it atomically persist the audited
selection at
`/srv/agent-stack/.deploy-state/caddy-network-selection.json`. Every later
production Caddy render validates and reapplies that record, so a normal deploy
cannot silently return to the repository template's testnet upstreams.

At any time, answer “which network is live, and who selected it?” with:

```sh
sudo /srv/agent-stack/app/scripts/ops/flip-caddy-network.sh status
```

The status includes the selected network and expected chain, live Caddy route,
consistency, UTC selection time, actor, execution user, host, operation ID,
reason, and source Git revision, followed by the public health chain ID.

Explicit rollback while the testnet stack is retained:

```sh
sudo /srv/agent-stack/app/scripts/ops/flip-caddy-network.sh testnet
```

That one operation retains the same internal target check, candidate validation,
reload validation, public chain assertion, auto-rollback, and durable audit
record update as the mainnet cutover.

Only after the public mainnet health and monitoring window are clean should PR
#753 be merged and the testnet containers be stopped. Keep the provider VM,
database/Redis, encrypted configuration, and Caddy snapshots for the agreed
rollback window.

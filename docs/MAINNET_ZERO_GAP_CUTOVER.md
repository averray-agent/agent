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

The launch record must keep `parameters.dailyOutflowCap` equal to string `"0"`.
The preflight refuses to start the sidecar if the cap is armed, the owner record
is not a final mapped 2-of-3, or the deployment owner differs from the mapped
multisig.

## 3. Render and preflight the mainnet runtime

Install the three mainnet certificate/key pairs under
`/etc/agent-stack-mainnet/roles-anywhere` as mode `0400 root:root` — the same for
both the certificate and the private key in every pair — and install
`deploy/aws-config.mainnet` as `/etc/agent-stack-mainnet/aws-config`. Render the
mainnet backend/indexer templates into `/run/agent-stack-mainnet` using the
scoped mainnet service-account tokens.

Run:

```sh
sudo /srv/agent-stack/app/scripts/ops/preflight-mainnet-sidecar.sh
```

The preflight checks certificate/key pairing, mode and ownership (`0400
root:root` for both cert and key; looser modes such as `0600`/`0644` are
rejected), expiry, exact AWS profiles,
absence of static AWS credentials, mainnet chain/RPC identity, isolated Redis
and indexer DNS, completed contract/owner records, unarmed outflow cap, valid
compose, and health of all five live testnet containers.

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

Do not run this command until the GO gate is fully green:

```sh
sudo /srv/agent-stack/app/scripts/ops/flip-caddy-network.sh mainnet
```

The script checks the target internally, locks cutover operations, renders a
pure Caddy upstream state, preserves a timestamped Caddyfile, validates, and
reloads Caddy. It then requires public `/health` to report chain ID `420420419`.
Any validation, reload, or health failure restores and reloads the prior route.

Explicit rollback while the testnet stack is retained:

```sh
sudo /srv/agent-stack/app/scripts/ops/flip-caddy-network.sh testnet
```

Only after the public mainnet health and monitoring window are clean should PR
#753 be merged and the testnet containers be stopped. Keep the provider VM,
database/Redis, encrypted configuration, and Caddy snapshots for the agreed
rollback window.

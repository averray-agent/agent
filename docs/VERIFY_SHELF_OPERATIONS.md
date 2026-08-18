# Averray Verify shelf — runtime boundary

`POST /verify/runs` is public, but untrusted repository code never executes in
the public backend. The backend downloads and hash-checks the two HTTPS
artifacts, writes a bounded task to `WITNESS_VERIFY_QUEUE_ROOT`, and waits for
the offline Witness worker. The worker has no network namespace and receives no
backend env file, wallet key, KMS credential, Redis URL, or payment capability.
It alone runs the existing Witness Docker sandbox.

Install the checked-in unit on the VPS, create the matching queue/work roots,
and start the network selected by the deploy (`testnet` or `mainnet`):

```sh
sudo install -m 0644 deploy/averray-witness-verify@.service /etc/systemd/system/
sudo install -d -o ubuntu -g ubuntu -m 0700 /srv/agent-stack/verify-queue /srv/agent-stack/witness-work
sudo install -d -o ubuntu -g ubuntu -m 0700 /srv/agent-stack-mainnet/verify-queue /srv/agent-stack-mainnet/witness-work
sudo systemctl daemon-reload
sudo systemctl enable --now averray-witness-verify@mainnet.service
```

The selected backend container mounts only its queue directory at the identical
absolute path. Never mount `/var/run/docker.sock` into the public backend.
`WITNESS_VERIFY_QUEUE_GID` must equal the numeric `ubuntu` group id on the VPS
(`getent group ubuntu`); the committed templates use the current value `1000`.
Artifacts and task records remain `0640`, scoped to root plus that worker group.
Startup is fail-closed: when `X402_VERIFY_MODE=enabled`, a missing or stale
worker heartbeat aborts backend startup, so the discovery manifest cannot
advertise a purchasable profile backed by a dead runner.

The worker must start before the backend. Its first startup builds or verifies
the pinned `averray-witness-preflight` image. A run that loses the worker after
startup times out as `inconclusive/runner_fault`; its x402 authorization is not
collected.

Each conclusive run collects exactly 5 USDC to `X402_PAYMENT_PAY_TO` on Base.
There is no Hub float, bridge, escrow adapter, or implicit treasury sweep in
this rail. That balance remains a separate Verify-revenue line until an
operator later performs and evidences an explicit Base-to-Hub sweep.

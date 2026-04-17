# Production Readiness Checklist

This is the operator-facing gate for promoting Averray from a healthy
testnet deployment into something we can treat like a real production
service. It complements:

- [VPS_RUNBOOK.md](../VPS_RUNBOOK.md) for day-to-day hosting operations
- [MULTISIG_SETUP.md](./MULTISIG_SETUP.md) for owner/pauser control-plane setup
- [AUDIT_PACKAGE.md](./AUDIT_PACKAGE.md) for external review scope and sign-off

If this checklist is not green, the answer is "not ready yet".

---

## 1. Control plane

- [ ] `TreasuryPolicy.owner` is the intended multisig address.
- [ ] `TreasuryPolicy.pauser` is a hot key that only holds pause power.
- [ ] `./scripts/verify_deployment.sh testnet` passes cleanly.
- [ ] Pause and unpause were rehearsed from the pauser key.
- [ ] At least one owner-only admin operation was rehearsed from the multisig.

See [MULTISIG_SETUP.md](./MULTISIG_SETUP.md) for the exact rehearsal flow.

---

## 2. Data durability

- [ ] Latest Postgres backup exists and is restorable.
- [ ] Latest Redis backup exists and is restorable.
- [ ] The monthly restore drill has been run at least once on the current stack shape.

Use:

```bash
./scripts/ops/backup-postgres.sh
./scripts/ops/backup-redis.sh
```

Restore drills are documented in [VPS_RUNBOOK.md](../VPS_RUNBOOK.md).

---

## 3. Hosted service health

- [ ] Public site loads at `https://averray.com/`.
- [ ] Discovery manifest loads at `https://averray.com/.well-known/agent-tools.json`.
- [ ] Operator app loads at `https://app.averray.com/`.
- [ ] API health is green at `https://api.averray.com/health`.
- [ ] Indexer readiness is green at `https://index.averray.com/ready`.
- [ ] Indexer freshness is within the accepted lag budget.

Run:

```bash
./scripts/ops/check-hosted-stack.sh
```

---

## 4. Release gate

Before tagging or promoting a serious deployment, run the combined gate:

```bash
./scripts/ops/check-release-readiness.sh testnet
```

What it does:

1. Runs frontend tests.
2. Runs backend tests.
3. Rebuilds the public Astro landing page and syncs it into `site/`.
4. Typechecks the indexer workspace.
5. Verifies the deployed contracts against the manifest for the selected profile.
6. Runs the hosted-stack smoke check.

Useful overrides:

```bash
# If the stack is deliberately paused during an incident rehearsal:
ALLOW_PAUSED=1 ./scripts/ops/check-release-readiness.sh testnet

# If you only want the live hosted checks from a VPS shell:
RUN_FRONTEND_TESTS=0 RUN_BACKEND_TESTS=0 RUN_SITE_BUILD=0 RUN_INDEXER_TYPECHECK=0 \
  ./scripts/ops/check-release-readiness.sh testnet
```

---

## 5. Observability

- [ ] Backend metrics are reachable and, if public, bearer-protected.
- [ ] Backend Sentry is configured for the active environment.
- [ ] Frontend Sentry runtime config is set if browser error reporting is required.
- [ ] Structured logs are visible from the current deploy target.
- [ ] An alert destination is configured for hosted smoke-check failures.
- [ ] [INCIDENT_RESPONSE.md](./INCIDENT_RESPONSE.md) has named on-call ownership.

---

## 6. Product proof before production claims

- [ ] One complete worker loop has been run on the hosted stack:
  discover -> sign in -> preflight -> claim -> submit -> verify -> badge/profile
- [ ] Public discovery, schema, and trust pages reflect the current deployed behavior.
- [ ] Canonical public discovery manifest matches the API mirror.

If any of these drift, external agents will learn the wrong contract.

---

## 7. Mainnet blockers that still remain

This checklist improves release discipline, but it does not replace:

- external audit sign-off on the mainnet contract set
- explicitly chosen mainnet risk limits (`deploy_contracts.sh` now refuses to use the default testnet-style policy values on `PROFILE=mainnet`)
- a real, audited strategy adapter path instead of the mock vDOT adapter
- explicit incident ownership and paging

Until those are done, treat the stack as production-like testnet, not
irreversible real-funds infrastructure.

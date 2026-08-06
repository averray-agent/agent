# Packet: secrets calendar — separate hard expiry from rotation policy, and record how each date was verified

**Status:** spec ready — **Codex handoff packet**; Claude gates the handback.
**Origin:** 2026-08-06 credential review, prompted by the operator asking whether we
are "in sync and know what token/pw are live or need replacements".
**Author:** Claude (architect/gate). **Date:** 2026-08-06.
**Scope:** `docs/SECRETS_CALENDAR.yml` + `scripts/ops/check-secrets-calendar.mjs`
(+ its tests). No credential is rotated, read, or moved by this packet.

## Defect

The calendar's `expires_at` field means two incompatible things at once, and the
check cannot tell them apart:

- **hard expiry** — the credential *stops working* on that date. Missing it is an
  outage.
- **rotate-by policy** — the credential never auto-expires; the date is our own
  90-day hygiene rule. Missing it is debt, not an outage.

Live run, 2026-08-06 (`SECRETS_CALENDAR_SIMPLE_YAML=1 node
scripts/ops/check-secrets-calendar.mjs`): **9 ok · 8 warn · 0 fail**. All four
*dated* warnings are rotate-by policy, yet every one of them prints as
`expires in 5 days`:

| entry | date | what it really is |
|---|---|---|
| `resend-api-key` | 2026-08-11 | 90d policy; Resend keys do not auto-expire |
| `app-basic-auth` | 2026-08-11 | 90d policy; it is a password |
| `auth-jwt-secrets` | 2026-08-11 | 90d policy; it is a signing secret |
| `aws-signer-testnet` | 2026-08-14 | 90d policy after provisioning |

An operator reading "expires in 5 days" four times, checking, and finding nothing
breaks, learns to ignore the check. This repo has already paid for that lesson once
(eight flapping capability alerts in a day, 2026-08-04) and the fix there was the
same shape: make the signal mean one thing.

## Second defect: the calendar is *declared*, never *observed*

`expires_at` is hand-typed. Nothing compares it to the actual credential, and the
entries admit it — the four `op-token-prod-*` entries carry
`2026-09-30   # Rotate-by target (~90d). Set the real 1P token expiry on/before
this, then confirm here`. So **the real 1Password service-account expiries are
unknown**, and the calendar displays them as ✅ 55 days.

The failure mode is silent and one-directional: a *pessimistic* declared date only
causes early rotation, but an *optimistic* one reads green until the credential
dies. Today four entries say `TBD` (honest) and five say a target date the notes
themselves flag as unconfirmed (not honest — it renders identical to a verified
date).

**Proof that observation beats declaration**, measured on the VPS 2026-08-06:
`aws-roles-anywhere-client-cert` is recorded `expires_at: "TBD"` with a note
describing a *7-day* self-managed-CA cadence. Reality:

```
# host /etc/agent-stack-mainnet/roles-anywhere/  (bind-mounted into agent-mainnet-backend)
badge-receipt-signer-cert.pem  notAfter=Oct 12 14:47:45 2026 GMT
signer-cert.pem                notAfter=Oct 12 14:47:43 2026 GMT
jwt-signer-cert.pem            notAfter=Oct 12 14:47:43 2026 GMT
```

90-day certs, not 7-day, and the real date is knowable in one command. Two
warnings for whoever implements this:

1. **There are two cert directories and the obvious one is dead.** The container
   path `/etc/agent-stack/roles-anywhere` is a *mount* whose host source is
   `/etc/agent-stack-mainnet/roles-anywhere`. The host's own
   `/etc/agent-stack/roles-anywhere/` holds a decommissioned stack's certs
   (signer + jwt-signer `notAfter=Aug 17 2026`) that **no running container
   mounts**. Reading that directory produces a false "mainnet auth breaks in 11
   days". Confirm with `docker inspect <container> --format '{{range .Mounts}}…'`
   before trusting any path.
2. `AWS_USE_ROLES_ANYWHERE=true` on `agent-mainnet-backend` — this path is live,
   so the Oct 12 date is load-bearing for mainnet KMS JWT signing.

## Third defect: the entire MAINNET service-account set is untracked

The calendar tracks five `op-token-prod-*` entries. The 2026-07-27 mainnet cutover
introduced a **parallel set**, defined in `scripts/ops/bootstrap-mainnet-vault.mjs`
and minted with the same hardcoded `--expires-in 90d` (line 155, asserted by
`bootstrap-mainnet-vault.test.mjs`):

| service account | reads |
|---|---|
| `averray-mainnet-ci-deploy` | `mainnet-ci`, `mainnet-ci-external` |
| `averray-mainnet-vps-backend` | `mainnet-backend`, `mainnet-backend-external`, `mainnet-observability` |
| `averray-mainnet-vps-indexer` | `mainnet-indexer` |
| `averray-mainnet-smoke-tests` | `mainnet-smoke` |
| `averray-mainnet-admin-refresh-rw` | `mainnet-backend` (read **+ write**) |

**Not one of them appears in `docs/SECRETS_CALENDAR.yml`.** They are live: the
bootstrap declares their consumers (`service: "mainnet-sidecar-render"`), and the
token files exist on the VPS. Measured 2026-08-06:

```
2026-07-25 16:38  /etc/agent-stack-mainnet/op-backend.env   OP_SERVICE_ACCOUNT_TOKEN   ← mainnet, UNTRACKED
2026-07-25 16:38  /etc/agent-stack-mainnet/op-indexer.env   OP_SERVICE_ACCOUNT_TOKEN   ← mainnet, UNTRACKED
2026-06-30 11:13  /etc/agent-stack/op-backend.env           OP_SERVICE_ACCOUNT_TOKEN   ← the tracked prod set
2026-06-30 11:36  /etc/agent-stack/op-indexer.env           OP_SERVICE_ACCOUNT_TOKEN
```

File mtime is when the token was written, so at the 90-day policy the mainnet pair
lands ≈ **2026-10-23** with nothing watching it. When `averray-mainnet-vps-backend`
expires, the mainnet backend cannot render its runtime secrets.

**And the same arithmetic quietly indicts a tracked entry.** The prod pair was
written 2026-06-30; +90d is ≈ **2026-09-28**. The calendar declares
**2026-09-30** — optimistic by about two days, i.e. it reads green *after* the real
expiry. That is precisely the drift `verified_at` exists to expose, and it is the
dangerous direction.

**Required:** add all five mainnet accounts as `kind: hard-expiry`. Use the real
date if read from the admin console; otherwise `expires_at: "TBD"`, which the new
check surfaces as "real expiry unknown — measure it". An untracked mainnet
credential must at minimum warn. Also confirm whether
`/etc/agent-stack-mainnet/op-refresh.env` (the declared consumer for
`averray-mainnet-admin-refresh-rw`) exists — it was **not** present in the
2026-08-06 listing, so either that account is consumed elsewhere or it was never
provisioned; both are worth knowing.

## Measured against the 1Password admin console, 2026-08-06

The operator read the console (**Developer → Service accounts**). It reports
**19 service accounts**. The calendar tracks **5**. The full state:

| account | token expiry | last accessed | in the calendar? |
|---|---|---|---|
| `op-token-prod-vps-backend` | **EXPIRED ~1 month ago** | 2026-06-30 | yes — as `2026-09-30` ✅ |
| `prod-vps-indexer` | **EXPIRED ~1 month ago** | 2026-06-30 | no |
| `prod-smoke-tests` | **EXPIRED ~1 month ago** | 2026-05-13 | no |
| `op-token-prod-ci-deploy` | **EXPIRED ~1 month ago** | 2026-06-30 | yes — as `2026-09-30` ✅ |
| `op-token-prod-ci-deploy` (dup) | **EXPIRED ~1 month ago** | never | no |
| `canary-ci-prod-backend` | in ~1 month | 2026-06-30 | yes — as `2026-09-11` |
| `prod-vps-backend` | **doesn't expire** | 2026-08-04 | no |
| `prod-vps-indexer` (dup) | **doesn't expire** | 2026-08-04 | no |
| `prod-smoke-tests` (dup) | **doesn't expire** | 2026-07-27 | no |
| `prod-smoke-deploy` | **doesn't expire** | never | no |
| `op-token-prod-ci-deploy` ×3 (dups) | **doesn't expire** | 2026-08-06 / 2026-06-30 / never | partially |
| `pkuriger@averray.com` | doesn't expire | 2026-06-30 | n/a (human) |
| `averray-mainnet-ci-deploy` | in ~2 months | 2026-07-08 | **no** |
| `averray-mainnet-vps-backend` | in ~2 months | **2026-08-06** | **no** |
| `averray-mainnet-vps-indexer` | in ~2 months | **2026-08-06** | **no** |
| `averray-mainnet-smoke-tests` | in ~2 months | 2026-07-27 | **no** |
| `canary-ci-mainnet-smoke` | in ~3 months | **2026-08-06** | **no** |

### What this proves

1. **The calendar reports ✅ on already-dead credentials.** `op-token-prod-vps-backend`
   and `op-token-prod-ci-deploy` expired roughly a month ago; the calendar declares
   both `2026-09-30` and the check prints `expires in 55 days`. This is no longer a
   hypothetical drift risk — it is live, and in the one direction that reads green
   past the end.
2. **The 90-day policy was never applied to the live prod tokens.** Six accounts —
   including the ones actually in use (`prod-vps-backend`, `prod-vps-indexer`,
   last accessed 2026-08-04) — read **doesn't expire**. `bootstrap-mainnet-vault.mjs`
   hardcodes `--expires-in 90d`, and `docs/SECRETS.md` step 1 says "mint a new token
   … (90-day expiry)", but the prod set does not follow it. A non-expiring token is
   valid forever once leaked, which is the risk the policy existed to bound.
3. **Nothing is currently broken, by luck rather than design.** Every expired account
   was last accessed 2026-05/06; the live consumers are on the non-expiring
   duplicates. An expired token that nothing calls causes no outage — but the state
   is indistinguishable, from the calendar, from a healthy one.
4. **Name collisions make the calendar ambiguous.** Five accounts are named
   `op-token-prod-ci-deploy` and three `prod-smoke-tests`, in different states
   (expired / non-expiring / never used). A calendar entry keyed on that name cannot
   identify which account it tracks. **Entries must carry the account's unique
   identity, not a display name that repeats five times.**
5. **The mainnet five exist and are live** — `averray-mainnet-vps-backend`,
   `-vps-indexer` and `canary-ci-mainnet-smoke` were all accessed on 2026-08-06 —
   and none is tracked. Their real horizon is ~2 months (≈2026-10-06 to 10-23),
   consistent with the 2026-07-25 token-file mtimes.
6. **`averray-mainnet-admin-refresh-rw` does not appear in the console at all**,
   matching the absent `/etc/agent-stack-mainnet/op-refresh.env` on the VPS —
   **traced below.**

### Traced: who actually writes the rotated refresh tokens

The chain, from the workflows down:

- `hosted-worker-canary.yml:236` and `deploy-production.yml:481` set
  `ADMIN_REFRESH_TOKEN_OP: op://mainnet-smoke/admin-refresh-token-*` and
  authenticate with the GitHub secret **`OP_SERVICE_ACCOUNT_TOKEN_MAINNET_SMOKE`**
  (repo secret, last set **2026-07-27T10:17:33Z** — the cutover).
- `scripts/ops/get-admin-refresh-token.mjs` performs a real write through
  `writeOpSecret` / `persistAndVerifySecret`, including a **"write-capability
  preflight"** before consuming the token.
- `docs/WORKER_CANARY.md:94` describes that secret's account as a
  "**mainnet-smoke-only service account with read/write permission**, used to
  rotate only `admin-refresh-token-worker-canary`."

So the writer is whatever account backs `OP_SERVICE_ACCOUNT_TOKEN_MAINNET_SMOKE`,
and it needs **write on `mainnet-smoke`**. In the console the match is
**`canary-ci-mainnet-smoke`** — expiry ~3 months, last accessed **2026-08-06
08:46**, i.e. it is the account doing this today. It **appears nowhere in this
repository** (`git grep canary-ci-mainnet` → no hits): created by hand, never
recorded.

**This exposes a defect in `bootstrap-mainnet-vault.mjs`, not just in the calendar.**
The bootstrap declares the rotation account as `averray-mainnet-admin-refresh-rw`
with `reads: ["mainnet-backend"], writes: ["mainnet-backend"]` — but **the refresh
chains live in `mainnet-smoke`, not `mainnet-backend`**. The deployed reality is
correct and the committed design is wrong: re-running the bootstrap today would mint
an account with write on the wrong vault, and the rotation would fail its own
write-capability preflight.

**Confidence:** the *role* is documented and evidenced; the *specific account* is a
strong inference from name, vault scope and a same-morning access timestamp. One
click confirms it — open `canary-ci-mainnet-smoke` in the console and check that its
single vault is `mainnet-smoke` with write. **Route the bootstrap correction as its
own change**; this packet only records the finding.

### Consequences for this packet

- Add an identity field (1Password account UUID, or the console URL) to every
  service-account entry. A name that repeats five times is not a key.
- The five mainnet accounts get entries (finding 5).
- The `expires_at` on the two provably-expired entries must be corrected to the real
  state, not merely re-dated forward.
- Whether the live prod tokens *should* be non-expiring is an **operator policy
  decision, not a packet decision** — record what is true today (`doesn't expire`,
  which the schema must be able to express distinctly from `never` used for
  "no expiry concept"), and route the policy question separately.
- **Deleting or revoking the expired/duplicate accounts is operator-only** and is
  explicitly NOT part of this packet.

## Fix contract

### 1. Schema — `docs/SECRETS_CALENDAR.yml`

Add a **required** `kind` to every entry:

| `kind` | meaning | `expires_at` |
|---|---|---|
| `hard-expiry` | the credential stops working on that date | date or `TBD` |
| `rotate-by` | our own hygiene policy; nothing breaks | date or `TBD` |
| `none` | genuinely no expiry concept | must be `never` |
| `unknown` | not yet classified | anything |

Add two optional fields, **required when `kind: hard-expiry` and `expires_at` is a
date**:

- `verified_at:` — ISO date the value was last confirmed *against the real
  credential*.
- `verified_by:` — how, in one line, reproducible (e.g.
  `openssl x509 -enddate -noout -in /etc/agent-stack-mainnet/roles-anywhere/jwt-signer-cert.pem`).

`kind` is required with **no default**. An unclassified entry must warn, not be
guessed — the whole defect is a field that silently meant two things.

Document the fields in the file's existing header comment, including *why*:
a rotate-by date is our policy and needs no verification; a hard-expiry date is an
external fact and is worthless unless someone has checked it.

### 2. Checker — `scripts/ops/check-secrets-calendar.mjs`

Classification becomes kind-aware. **Exit codes do not change** (0 = ok/warn,
1 = script error, 2 = past a hard expiry) so CI semantics are untouched.

```
kind: hard-expiry
  expires_at past                  → fail   "EXPIRED n days ago — this credential no longer works"
  ≤ fail_within_days               → fail   "expires in n days"
  ≤ warn_days                      → warn   "expires in n days"
  expires_at: TBD                  → warn   "real expiry unknown — measure it"
  verified_at absent, or older than
  config.verification_max_age_days
  (default 180)                    → warn   "expiry unverified since <date> — confirm against the real credential"
  otherwise                        → ok

kind: rotate-by
  expires_at past                  → warn   "rotation overdue by n days (policy, not an outage)"   ← NEVER fail
  ≤ warn_days                      → warn   "rotation due in n days"
  expires_at: TBD                  → warn   "rotation date not set"
  otherwise                        → ok
  verified_at/verified_by not required — the date is our own policy, not an external fact.

kind: none        → skip (and error if expires_at is not "never")
kind: unknown     → warn "not classified — hard expiry or rotation policy?"
kind missing/other→ error (exit 1)
```

Wording is part of the contract: a `rotate-by` line must never contain the word
"expires", and a `hard-expiry` line must never be softened to "rotation". That is
the whole point of the packet.

The summary line must count the two kinds separately, e.g.
`summary: 9 ok · 2 expiries approaching · 4 rotations due · 1 unverified · 0 fail`.
An operator has to be able to read urgency off one line.

### 3. Data — classify all existing entries

Proposed classification below. **The basis column is the standard**: where it says
*entry's own note*, the note already states it; where it says *inference*, Codex
must confirm before shipping, and any entry that cannot be confirmed ships as
`kind: unknown` rather than a guess. Do not copy my inferences in as fact.

| entry | kind | basis |
|---|---|---|
| `admin-eoa-mainnet` | `none` | a keypair; entry says `never` |
| `admin-refresh-token-mainnet-smoke` | `hard-expiry` | 30-day rolling refresh chain; dies if unused |
| `admin-refresh-token-mainnet-worker-canary` | `hard-expiry` | same |
| `admin-refresh-token-mainnet-production-deploy` | `hard-expiry` | same |
| `ADMIN_JWT` | `none` | testnet-only, re-minted on demand; entry says `never` |
| `github-pat-issue-ingestion` | `hard-expiry` | entry's own note: "GitHub PATs typically default to 90d" — **real date must be measured** |
| `pimlico-api-key` | `rotate-by` | entry's own note: "keys don't auto-expire" |
| `subscan-api-key` | `rotate-by` | entry's own note: "vendor cycle, treat as 90d rotation" |
| `resend-api-key` | `rotate-by` | entry's own note: 90d after a rotation; Resend keys persist |
| `sentry-dsn` | `none` | entry's own note: project-lifetime |
| `op-token-prod-ci-deploy` | `hard-expiry` | 1P SA tokens expire; note admits date is a target → **unverified** |
| `op-token-prod-vps-backend` | `hard-expiry` | same |
| `op-token-prod-vps-indexer` | `hard-expiry` | same |
| `op-token-prod-smoke-tests` | `hard-expiry` | same |
| `op-token-prod-backend-canary` | `hard-expiry` | note records `--expires-in 90d` from 2026-06-13 → 2026-09-11 is real; set `verified_at: 2026-06-13` |
| `aws-roles-anywhere-client-cert` | `hard-expiry` | **measured** — see below |
| `vps-ssh-key` | `rotate-by` | inference: SSH keys do not expire |
| `aws-signer-testnet` | `rotate-by` | inference: IAM access keys do not auto-expire — confirm |
| `app-basic-auth` | `rotate-by` | inference: a password |
| `auth-jwt-secrets` | `rotate-by` | inference: a signing secret |

**One TBD is resolved by this packet.** Set on `aws-roles-anywhere-client-cert`:

```yaml
    kind: hard-expiry
    expires_at: "2026-10-12"
    verified_at: "2026-08-06"
    verified_by: |
      sudo openssl x509 -enddate -noout -in \
        /etc/agent-stack-mainnet/roles-anywhere/{signer,jwt-signer,badge-receipt-signer}-cert.pem
      All three notAfter 2026-10-12 (mainnet). NOTE the host path: the container's
      /etc/agent-stack/roles-anywhere is a mount FROM /etc/agent-stack-mainnet/...;
      the host's own /etc/agent-stack/roles-anywhere holds a decommissioned stack's
      certs (Aug 17) that nothing mounts.
```

Also correct that entry's description: it documents a 7-day self-managed-CA cadence
that is not what is deployed (90-day certs). Keep the reissue procedure, mark the
cadence as *planned, not current*.

## Regression tests (required)

Extend the existing checker test file. Every rule above needs one, but these are the
ones that encode the defect:

1. `rotate-by` past its date → **warn, and the process exits 0**. This is the test
   that proves hygiene debt can never masquerade as an outage.
2. `hard-expiry` past its date → **fail, exit 2**. The existing contract survives.
3. `hard-expiry` far from expiry but `verified_at` older than
   `verification_max_age_days` → **warn**. A stale-but-green date is the silent
   failure this packet exists to surface.
4. `hard-expiry` with a date and no `verified_at` → warn.
5. `rotate-by` with no `verified_at` → **ok** (not required for policy dates).
6. `kind: unknown` → warn; `kind` missing → error, exit 1.
7. `kind: none` with a real date (not `never`) → error.
8. Wording guards: a `rotate-by` output line does not contain "expires"; a
   `hard-expiry` line does not contain "rotation".
9. **Guard over the shipped calendar**: every entry in the real
   `docs/SECRETS_CALENDAR.yml` parses and carries a valid `kind`. This is what stops
   the next added entry from silently reintroducing the ambiguity.

## Acceptance gate (Claude, on handback)

1. `node scripts/ops/check-secrets-calendar.mjs` → exit 0, **0 fail**, and the four
   2026-08-11/14 entries read as *rotation due*, not *expires*.
2. `aws-roles-anywhere-client-cert` carries `2026-10-12` + `verified_at` +
   a `verified_by` command I can re-run.
3. Removing `kind` from any entry fails test 9; flipping `resend-api-key` to
   `hard-expiry` and back-dating it fails test 2 — i.e. the tests fail for the right
   reason, not merely pass.
4. Every `inference`-basis row is either confirmed with a stated basis or shipped as
   `kind: unknown`. **A guess dressed as a classification is a worse defect than the
   one being fixed.**
5. No credential value appears in any diff, log, or test fixture.

## Operator action — the one thing this packet cannot do

The five `op-token-prod-*` real expiries can only be read from 1Password, which no
agent here can reach (service-account auth does not propagate to our shells). Pascal:

**`op service-account list` does not exist** — the CLI exposes only
`op service-account create` and `... ratelimit` (verified against the live CLI,
2026-08-06). Service-account expiries are readable only in the web admin:

> **1Password.com → Developer → Service accounts →** select each account.

Read the expiry for all ten (five `prod`, five `mainnet`). Send the dates and Codex sets
`expires_at` + `verified_at` + `verified_by: "op service-account list, <date>"`.
Until then those five stay `hard-expiry` with a target date and **no**
`verified_at`, which the new check surfaces as "unverified" — the honest state,
and visibly different from a confirmed date.

## Non-goals (route separately)

- **Surfacing the calendar in the morning Buzz digest.** Deliberately sequenced
  *after* this packet: piping today's output to a phone would deliver four
  "expires in 5 days" alerts about credentials that do not expire, undoing the
  alert-noise work of 2026-08-05.
- **Deleting the orphaned legacy private keys** at
  `/etc/agent-stack/roles-anywhere/*-key.pem` (a decommissioned stack's keys still
  on disk). Real hygiene, but deleting private keys is operator-only.
- **Rotating anything.** This packet changes how dates are described and checked,
  never a credential.
- Automating verification (querying vendors/1Password from CI). `verified_at` is the
  groundwork; the automation is a later packet, and needs its own credential story.

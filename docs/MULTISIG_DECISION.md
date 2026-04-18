# Multisig Decision Record

This document records the recommended multisig approach for Averray.

It does not replace the full setup walkthrough in
[docs/MULTISIG_SETUP.md](/Users/pascalkuriger/repo/Polkadot/docs/MULTISIG_SETUP.md).
Instead, it explains **which multisig stack to use and why**.

---

## Decision

For Averray, the recommended multisig stack is:

- **Multisig app**: Signet / Polkadot Multisig
- **Signer wallet**: Talisman
- **Initial threshold**: `2-of-3`

This is the recommended launch posture unless a concrete limitation forces a
different choice later.

---

## Why this is the current recommendation

### 1. Best fit with the current workflow

The team is already close to a Talisman-centric operator workflow. Signet is
the cleanest extension of that setup because it explicitly supports Talisman as
the signer wallet and includes a documented flow for using the resulting vault
through Talisman in dapps.

Sources:

- [What is Polkadot Multisig by Signet?](https://guide.polkadotmultisig.com/en/category/about-polkadot-multisig/article/what-is-polkadot-multisig-by-signet)
- [What wallets are supported by Polkadot Multisig?](https://guide.polkadotmultisig.com/en/category/about-polkadot-multisig/article/what-wallets-are-supported-by-polkadot-multisig)
- [Adding your multisig to Talisman](https://guide.polkadotmultisig.com/en/category/multisig-basics/article/making-your-first-transaction)

### 2. Good security / usability balance

The Signet docs describe a vault model based on Polkadot-native structures that
supports a Gnosis-Safe-style workflow where the operational address can remain
stable while the signer set can evolve.

Source:

- [Supported vault / multisig types](https://guide.polkadotmultisig.com/en/category/multisig-basics/article/supported-vault-multisig-types)

### 3. Better launch fit than the alternatives

Compared with the alternatives reviewed:

- **Mimir** looks stronger for more advanced account topology and broader
  governance-heavy use cases.
- **Nova Spektr** looks stronger for a more dedicated enterprise wallet and
  trust-minimized desktop posture.
- **Signet** looks best for a fast, practical launch with a small team already
  comfortable with Talisman.

Relevant sources:

- [Polkadot multisig apps overview](https://wiki.polkadot.com/general/multisig-apps/)
- [Mimir accounts](https://docs.mimir.global/basic/accounts)
- [Nova Spektr multisig wallet](https://docs.novaspektr.io/wallet-management/multisig-wallet)

---

## Recommended threshold

Use **`2-of-3`** for launch.

Why:

- much safer than single-key control
- does not block normal operations if one signer is unavailable
- easier to operate than a larger committee while the system is still young

Avoid for launch:

- `1-of-N`
- unnecessarily large signer sets
- deeply nested structures unless a real governance requirement appears

---

## Recommended signer model

Use three distinct signer roles:

- **Primary operator signer**
  - used for normal day-to-day approvals
- **Secondary core signer**
  - controlled by a second trusted team member or co-owner
- **Recovery / cold signer**
  - stored on a separate device with stronger backup discipline

The important rule is separation, not titles.

Do not let one person control all three signers as a permanent arrangement.

---

## What the multisig should control

Use the multisig for:

- treasury custody
- contract ownership
- high-impact governance actions
- verifier / pauser / operator rotation where appropriate
- any irreversible production control-plane change

Do not overload it with every low-risk action. Keep:

- local development wallets
- testing wallets
- low-risk hot operational flows

outside the main treasury multisig when possible.

---

## When to reconsider this decision

Revisit the choice if any of these become true:

- the team needs more advanced nested or flexible account patterns quickly
- governance activity becomes heavier than treasury operations
- the team wants a more dedicated desktop or light-client security posture
- Signet’s operating model becomes a blocker for integrations or approvals

In that case:

- revisit **Mimir** first for more complex account and governance structures
- revisit **Nova Spektr** first for a more dedicated enterprise wallet posture

---

## Related docs

- [docs/MULTISIG_SETUP.md](/Users/pascalkuriger/repo/Polkadot/docs/MULTISIG_SETUP.md)
- [docs/PRODUCTION_CHECKLIST.md](/Users/pascalkuriger/repo/Polkadot/docs/PRODUCTION_CHECKLIST.md)
- [docs/MAINNET_PARAMETERS.md](/Users/pascalkuriger/repo/Polkadot/docs/MAINNET_PARAMETERS.md)

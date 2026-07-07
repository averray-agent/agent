# Signer Policy

This is the practical signer checklist for Averray's launch multisig.

Use it together with:

- [docs/MULTISIG_DECISION.md](/Users/pascalkuriger/repo/Polkadot/docs/MULTISIG_DECISION.md)
- [docs/MULTISIG_SETUP.md](/Users/pascalkuriger/repo/Polkadot/docs/MULTISIG_SETUP.md)

---

## Target shape

- multisig app: **Signet / Polkadot Multisig**
- signer wallet layer: **Talisman**
- threshold: **2-of-3**

---

## Signer roles

> **All three signers are dedicated Ledger hardware wallets** — the private key
> never leaves the secure element. The A/B/C split below is an **access/location**
> tier (how reachable each device is), **not** hardware-vs-software: none of the
> three is a browser-extension or software wallet.

### Signer A — primary operator

Purpose:

- normal day-to-day approvals
- fastest access during regular operating hours

Requirements:

- dedicated Ledger hardware wallet (secure element; key never exported)
- device used only for treasury signing
- separate steel seed backup, stored apart from the device and from all other signers

### Signer B — second core signer

Purpose:

- second approval for normal treasury and admin actions
- resilience if the primary operator is unavailable

Requirements:

- controlled by a different trusted person when possible
- different device from Signer A
- separate backup location

### Signer C — cold / recovery signer

Purpose:

- backup approval
- recovery path if one hot signer is lost or compromised

Requirements:

- hardware-backed (Ledger) — required, as for all three signers
- kept in deep offline storage; not reached for routine ceremonies
- strongest backup discipline of the three

---

## Mandatory separation rules

- each signer must use a different seed
- no signer may share a recovery phrase with another signer
- no two signers should live on the same device
- backups must not be stored in the same location
- each steel backup plate lives apart from its own device (never together)
- no signer is a browser-extension or software-only key — all three are Ledger
  hardware wallets

If these are not true, the multisig may look distributed while still being a
single point of failure in practice.

---

## Before any real funds move

All of these must be true:

- [ ] each signer can sign in successfully
- [ ] each signer can approve a test action
- [ ] the team has rehearsed one full `2-of-3` flow
- [ ] the vault address has been copied and cross-checked
- [ ] signer labels are documented privately
- [ ] a small inbound and outbound test transaction has succeeded

Do not move meaningful funds until this checklist is complete.

---

## Daily operating rules

- use the multisig only for actions that justify shared approval
- keep signer devices (Ledger firmware) updated; drive signing from a dedicated,
  clean machine/browser profile — the key stays on the device either way
- always confirm the destination address and calldata **on the Ledger screen**
  itself before approving (never trust only the host display)
- document important approvals in an operator note or internal log

For any unusual transaction:

- require the initiator to explain what the transaction does in plain language
- require the second signer to verify that explanation independently

---

## Incident rules

If any signer device or seed may be compromised:

1. stop using that signer immediately
2. pause critical systems if necessary
3. move to recovery or signer rotation
4. document the incident
5. do not resume normal treasury operations until the signer set is trusted
   again

If one signer is merely unavailable but not compromised:

- continue using the other two signers only if the threshold and backup model
  still make sense operationally

---

## Anti-patterns

Do not do these:

- one person controlling all signers as a permanent setup
- storing all recovery phrases in one password manager entry
- provisioning any signer as a browser-extension or software wallet (all three must be Ledger hardware)
- storing a steel backup plate next to the device it backs
- skipping a real test transaction before funding the vault
- using the treasury multisig as a convenience wallet for every small action

---

## Review cadence

Review the signer policy:

- before mainnet cutover
- after any signer rotation
- after any security incident
- at least once per quarter while funds are live

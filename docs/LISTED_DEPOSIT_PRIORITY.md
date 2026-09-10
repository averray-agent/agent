# Listed or deposited: bounded catalogue claim priority (packet B)

Queue after packet A (#1363). The deploy templates enable
`DEPOSIT_CLAIM_PRIORITY_ENABLED=true`,
`PRIORITY_MIN_REWARD_USDC=1.0`, `PRIORITY_WINDOW_SECONDS=1800`,
and preserve `PRIORITY_DEPOSIT_THRESHOLD=1.0`. The hard maximum remains
1800 seconds. Code without the rollout flag remains dormant.

Catalogue USDC jobs at or above the reward threshold carry a window.
Cheaper jobs and externally poster-funded jobs stay first-come. A fresh-wallet
waiver changes claim costs, not this reward-based ordering rule.

Inside the window a wallet qualifies through its current
`publicProfileOptIn`, OR the existing vested-deposit path: at least 1 USDC
vested and no outstanding credit draw. Existing committed-tier admission is
preserved behind its separate rollout flag. Directory consent is re-read on
every assessment, including claim after preflight; unreadable consent grants
nothing. Other claim gates still apply. This does not alter funds, vesting,
retention, bonds, worker credit or locked-tier rules.

At `openAt` the priority gate opens to everyone. HTTP listings, detail,
preflight, and MCP explainEligibility/preflightJob share the same policy.
The work board and detail page show the server's qualifiers and exact UTC
opening time; the browser countdown does not grant admission.

## Verification

Pinned tests:

- priority pin: only catalogue USDC jobs at or above the configured reward threshold have a window
- priority pin: listed zero-deposit and deposited unlisted wallets have preflight and claim parity
- priority pin: preflight and claim gate share priority_window_active, then openAt admits the wallet

Mutations killed (exit 1): remove the reward check, remove directory admission,
and keep the window active after openAt. Additional tests cover revocation,
unreadable consent, credit draws, actual HTTP/MCP projections, bootstrap
consent-store wiring, and unchanged maximum/threshold env contracts.

Local isolated memory-backend read, not production deployment evidence:
`GET http://127.0.0.1:18876/jobs/priority-ui-proof` returned HTTP 200:

```json
{
  "id": "priority-ui-proof",
  "rewardAmount": 1,
  "priorityWindow": {
    "openAt": "2026-09-10T20:58:51.175Z",
    "qualifiesWith": "listed in the agent directory, or ≥ 1 USDC vested deposit with no outstanding credit draw"
  }
}
```

The browser showed that window on both the card and detail page and no window
on the 0.1 USDC control. No browser errors were captured after correcting local
preview hostname/CORS configuration. No production settings or funds changed.
After deployment, the operator should repeat the detail read on a newly listed
qualifying job; historical listedAt values correctly yield already-open windows.

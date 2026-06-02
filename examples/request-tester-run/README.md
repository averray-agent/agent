# Request a Hermes tester run (P8)

A thin helper a building agent in this repo can use to ask the **Hermes browser
tester** to run a mission against the product — without being able to run it
directly. The contract is **Discover → Request → (operator) Approve → Run →
Report**:

| Step | Call | Endpoint |
|------|------|----------|
| 1. Discover | `discoverTesterCapabilities()` | `GET /monitor/tester/capabilities` |
| 2. Request | `requestTesterRun({ requesterAgent, targetUrl, goal, reason, mode })` | `POST /monitor/testbed-missions/request` |
| 3. Approve | — | the operator approves the `requested` card on the Hermes board |
| 4. Run | — | the Hermes testbed runner claims + runs it |
| 5. Report | `readTesterReport({ missionId })` | `GET /monitor/testbed-missions/:id` |

## Security boundary (do not weaken)

- **Request-only.** This module exposes no run / approve / mutate call. Every
  actual run passes the operator approve gate (or an explicit trust policy).
- **Attributable + justified.** `requesterAgent` and `reason` are mandatory.
- **Read-only by default.** No mutation flag is ever sent; mutation stays
  server-enforced (testnet-only per the env binding). The server forces the
  mission to `requested` + read-only and ignores client-supplied run/mutation
  fields.

The tester is a separate Hermes service, not this repo's API. Point it at the
monitor base URL.

## Usage

```sh
# Discover what the tester can do
node examples/request-tester-run/index.mjs --monitor "$HERMES_MONITOR_URL" --token "$HERMES_MONITOR_TOKEN"

# Request a run (parks a board-gated card — the operator approves it)
node examples/request-tester-run/index.mjs --monitor "$HERMES_MONITOR_URL" --token "$HERMES_MONITOR_TOKEN" \
  --requester averray-agent --target https://app.averray.com/overview \
  --reason "Pre-merge UX check for the onboarding change" --goal "Reach the first receipt" --mode fresh

# Read a mission's report back by id
node examples/request-tester-run/index.mjs --monitor "$HERMES_MONITOR_URL" --report testbed-mission-abc
```

```js
import { requestTesterRun, readTesterReport } from "./index.mjs";

const { run } = await requestTesterRun({
  monitorUrl: process.env.HERMES_MONITOR_URL,
  token: process.env.HERMES_MONITOR_TOKEN,
  requesterAgent: "averray-agent",
  targetUrl: "https://app.averray.com/overview",
  reason: "Pre-merge UX check for the onboarding change",
});
// …operator approves on the board, the tester runs…
const report = await readTesterReport({ monitorUrl, token, missionId: run.id });
```

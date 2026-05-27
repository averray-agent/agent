# Hermes Handoff Monitor — Redesign Implementation Spec

- **Version:** 1.0
- **Status:** ready for implementation
- **Owner:** assigned engineer (Codex or Claude in IDE)
- **Source of truth for visuals:** the Claude Design handoff bundle (`hermes v2-handoff.zip`) — direction A, 8 artboards. The bundle's `averray-tokens.css` is byte-reconciled against the existing `frontend/styles.css`, so the new tokens **are** the production tokens. No migration step.
- **Source of truth for product contract:** the original brief at the top of this redesign cycle (board lanes, lifecycle, ownership, browser missions). Unchanged.

This document supersedes the chat-thread draft that preceded it.

---

## 1. Goal

Replace the existing terminal-aesthetic Hermes monitor with the Direction A redesign. Product contract is unchanged — the board, the lanes, the cards, the Hermes orchestration, the browser missions, all of it. What changes is the surface.

**Primary success metric:** the operator can answer *"is anything blocked on me right now?"* in one second from a fresh glance at the page. Validate by sitting with the operator for one shift after launch and counting how often they read instead of glance.

---

## 2. Bundle Contents (authoritative)

The design handoff bundle lives outside the repo; engineering should keep a local copy. Inventory:

| File | Role |
|---|---|
| `averray-tokens.css` | Reconciled design tokens (operator + marketing). Already matches production `frontend/styles.css`. |
| `hermes.css` | Monitor-specific token overlay (`--hm-*`) + all bespoke styles for the monitor surface. Includes the A8 a11y-bumped values. |
| `components.jsx` | React 18 implementation reference for every component (TopStrip, BoardNowBanner, Lane, Card, DetailDrawer, CoPilotRail, AskHermesComposer, KeyboardHints, etc.). |
| `artboards.jsx` | All board scenes (default, action-needed, drawer-open, Hermes-focused, empty/calm, mission-drawer). Keyboard wiring embedded. |
| `data.jsx` | Fixture cards with the full data model — engineering reads this to confirm field shapes. |
| `states.jsx` | A7 states sheet — every card type × every state, plus degraded-mode header pattern. |
| `index.html` | Prototype entry point. Loads React via UMD + Babel-standalone — **do not ship this pattern**; port to Next.js app-router. |

**Rule:** when this spec and the bundle disagree, the bundle wins. File a follow-up PR to update this spec.

---

## 3. Scope

In scope for v1:
- The board page (all five board states: default, action-needed, drawer-open, Hermes-focused, empty/calm)
- Browser mission detail drawer (A6)
- Card vocabulary: PR, deploy, browser mission, Codex task, draft, done — five state variants each (A7)
- Full keyboard navigation
- The persistent Hermes co-pilot rail
- Live data integration (GitHub, Codex runner, Hermes service, deploy verifier, browser-agent runtime)
- Degraded-mode UI per the A7 states sheet
- Three-tier notifications: in-app audio/visual + browser tab badge + desktop notification

Held for v1.1+:
- Mobile glance view
- Card relationships (PR-waits-on-PR arrows / stacked cards)
- Per-agent activity sparklines
- Bulk-select cards in a lane
- Time-travel board snapshots UI (log the data, don't surface it)
- Dark mode (build palette with semantic tokens; the bundle already does this — dark slot-in is cheap later)

---

## 4. Tech Stack & Architecture

- **Framework:** Next.js (app router), TypeScript strict.
- **Styling:** Tailwind + CSS variables. Tokens come from the bundle's `averray-tokens.css` (already in production) plus the `--hm-*` overlay from `hermes.css`. **No hex values in components.**
- **Live data:** SSE for push, REST for query, SWR for client cache.
- **State:** React + URL search params for shareable view state (`?lane`, `?card`, `?search`).
- **Auth:** reuses the operator-app SIWE + refresh-cookie flow. The monitor sits behind the same `(authed)` layout guard as the rest of the app (PR #462 / Package E).
- **Where it lives:** new route group `app/app/(authed)/monitor/` inside the existing operator-app workspace. Reuses the auth guard, the live-data bridge, and the Hermes refresh manager. No new workspace.

The prototype runs via React UMD + Babel-standalone in the browser. **Do not ship that pattern.** Port to compiled Next.js components; treat the JSX as a visual reference, not a copy-paste source.

---

## 5. File Layout

```
app/app/(authed)/monitor/
  layout.tsx                 ← optional sub-layout
  page.tsx                   ← board page entry
  loading.tsx                ← initial skeleton
  error.tsx                  ← top-level error boundary

app/components/monitor/
  TopStrip.tsx               ← brand mark + KPI pills + search + LIVE indicator
  TopStripDegraded.tsx       ← rose-tinted variant; ? on KPI counts when state is unknown
  BoardNowBanner.tsx         ← hero sentence + primary action (sage default / amber on action)
  Board.tsx                  ← lane orchestrator, computes lane sizing
  Lane.tsx                   ← single lane (expanded variant)
  MiniRail.tsx               ← collapsed lane representation (left + right rails)
  cards/
    CardShell.tsx            ← shared shell (header, body slot, footer slot, state ribbon)
    PRCard.tsx
    DeployCard.tsx
    MissionCard.tsx
    CodexTaskCard.tsx
    DraftCard.tsx
    DoneCard.tsx             ← compressed historical variant
    CardStates.tsx           ← composes the (type × state) matrix; reads from the same data model
  drawer/
    DetailDrawer.tsx         ← portal container, focus trap, esc/keyboard wiring
    PRDrawer.tsx
    MissionDrawer.tsx        ← A6
    CodexTaskDrawer.tsx
    DeployDrawer.tsx
    DraftDrawer.tsx
  hermes/
    CoPilotRail.tsx          ← right rail, always visible; toggles to focused mode
    HermesTurn.tsx           ← single chat turn (card-stream variant)
    AskHermesComposer.tsx    ← persistent composer at the bottom of the rail
    HermesNarration.tsx      ← single narration entry
  shortcuts/
    KeyboardOverlay.tsx      ← cheat-sheet; toggled by ?
    useKeyboardNav.ts        ← single hook owning the global handler

app/lib/monitor/
  board-state.ts             ← board state shape + derived selectors
  board-state.test.mjs
  card-types.ts              ← discriminated union for card types
  lane-rules.ts              ← which lane a card belongs in
  lane-rules.test.mjs
  urgency.ts                 ← freshness/staleness/urgency math
  urgency.test.mjs
  live-stream.ts             ← SSE client + reconnect strategy
  live-stream.test.mjs
  notifications.ts           ← browser tab badge + desktop notifications
  notifications.test.mjs
  keyboard-map.ts            ← single source of truth for shortcuts

app/lib/api/hooks/
  useBoardState.ts           ← SWR over /api/monitor/board
  useHermesStream.ts         ← Hermes co-pilot live stream
  useMissionReport.ts        ← per-mission detail fetch
```

Tests follow the existing project pattern (`*.test.mjs` colocated, run under `npm run test:app`). Extend the `test:app` glob to cover `app/lib/monitor/*.test.mjs`.

---

## 6. Data Model

Engineering should mirror this against the bundle's `data.jsx` shapes — those are authoritative.

```ts
type CardId = string;  // "agent #548" | "mission browser-onboard-04" | "task starter-coding-014" | "ext #246"

type Lane =
  | "needs-attention"
  | "drafts"
  | "codex-needed"
  | "hermes-checking"
  | "operator-review"
  | "release-queue"
  | "deploying"
  | "done";

type WaitingOn = {
  actor: "operator" | "author" | "agent" | "CI" | "relay" | "branch-protection";
  tone: "warn" | "info" | "neutral";
};

type BoardCard =
  | PRCard
  | MissionCard
  | CodexTaskCard
  | DeployCard
  | DraftCard
  | DoneCard;

type CardBase = {
  id: CardId;
  lane: Lane;
  type: "pr" | "mission" | "task" | "deploy" | "draft" | "done";
  agentType: "claude" | "codex" | "hermes" | "ext";
  title: string;
  summary: string;
  repo: string;
  branch?: string;
  freshness: number;             // minutes since entering current lane
  state: "fresh" | "stale" | "failed-fetch" | "source-offline" | "running";
  risk: RiskTag[];               // workflow, config, review-gated, contracts, secrets, indexer, xcm, docs, testbed, ui-only, deps, quality
  checks?: { pass: number; running: number; fail: number; pending: number; total: number };
  waitingOn: WaitingOn;
  isAction?: boolean;            // true ⇒ this card drives the action-needed lane
  isDraft?: boolean;             // true ⇒ render in drafts lane regardless of other state
  archiveHint?: boolean;         // true ⇒ stale-card "want to archive?" suggestion
};

type PRCard = CardBase & {
  type: "pr";
  files: { path: string; diff: string; critical: boolean }[];
  verdict?: string;              // Hermes's pre-check summary
  action?: { kind: "operator-review"; primary: string; secondary: string };
};

type MissionCard = CardBase & {
  type: "mission";
  mission: {
    verdict: "OK" | "PARTIAL" | "FAILED";
    verdictTone: "ok" | "warn" | "fail";
    confidence: number;          // 0..1
    latency: string;             // "2m 14s"
    target: string;              // URL under test
    seed: string;                // "fresh · no memory" or "memory · prior-run-id"
    runs: number;                // run number (4 = fourth)
    successScore: number;        // 0..10
    claritScore: number;         // 0..10 (clarity)
    latencyScore: number;        // 0..10
    path: { n: number; status: "ok" | "warn" | "fail"; desc: ReactNode; lat: string }[];
    blockers: { head: string; body: ReactNode }[];
    evidence: { kind: "screenshot" | "trace" | "console" | "video"; label: string; href: string }[];
    mutationBoundary: string;    // confirms read-only / what wasn't touched
    recommendations: string[];
  };
};

type CodexTaskCard = CardBase & {
  type: "task";
  prompt: string;
  action?: { kind: "codex-approve"; primary: string; secondary: string };
  runnerHeartbeat?: { lastSeen: string; online: boolean };  // only for "running"
  output?: string;               // streaming during run
  failureReason?: string;
};

type DeployCard = CardBase & {
  type: "deploy";
  deployId: string;              // e.g. "#246"
  verification: { current: number; total: number; label: string };
};

type DraftCard = CardBase & { type: "draft"; isDraft: true };
type DoneCard = CardBase & { type: "done"; closedAt: string; mergeStatus: "MERGED" | "CLOSED" };
```

**Lane derivation is a pure function**, lives in `lane-rules.ts`, and is unit-tested in `lane-rules.test.mjs`:

```ts
export function laneFor(card: BoardCard): Lane {
  if (card.isAction) return "needs-attention";
  if (card.isDraft) return "drafts";
  if (card.type === "task") return "codex-needed";
  if (card.type === "deploy") return "deploying";
  if (card.type === "done") return "done";
  return card.lane;  // explicit lane wins for cards Hermes has already classified
}
```

Disagreements get litigated in the test file, not in components.

---

## 7. Data Flow & Integration Points

```
External sources
  ├─ GitHub                  (webhooks + REST)
  ├─ Codex runner            (REST + heartbeat)
  ├─ Browser-agent runtime   (REST + SSE for mission progress)
  ├─ Deploy workflow         (GitHub Actions + post-merge verifier)
  └─ Hermes LLM service      (REST chat + SSE narration)
                  │
                  ▼
mcp-server (existing — endpoints to add)
  ├─ GET  /api/monitor/board               → aggregated board state
  ├─ GET  /api/monitor/cards/:id           → card detail
  ├─ GET  /api/monitor/stream              → SSE for live updates
  ├─ POST /api/monitor/hermes/chat         → ask Hermes a question
  ├─ GET  /api/monitor/hermes/stream       → SSE narration + replies
  ├─ GET  /api/monitor/mission/:id         → mission detail + report
  └─ POST /api/monitor/mission             → spawn a mission (admin-only)
                  │
                  ▼
Monitor frontend (this PR's scope)
  ├─ SWR for query, SSE for push
  ├─ Optimistic updates on operator actions
  └─ Single source of truth via React Context inside <Board>
```

**SSE event types** the frontend listens for:

```
board.card.added       { card }
board.card.updated     { id, partial }
board.card.moved       { id, fromLane, toLane }     // for animation
board.card.archived    { id, reason }
hermes.narration       { turn }
hermes.reply           { questionId, turn }
mission.step           { missionId, step }           // live-updating during run
mission.completed      { missionId, report }
codex.heartbeat        { taskId, lastSeen }
deploy.update          { deployId, status }
stream.degraded        { reason, lastGood: timestamp }
```

**Reconnect strategy:** exponential backoff (1s, 2s, 4s, 8s, max 30s). On reconnect, fetch full board state once to catch up, then resume streaming. While disconnected: LIVE indicator goes rose, header swaps to `TopStripDegraded` with `?` instead of `0` on the unknown KPIs, and the UNTRUSTED banner appears with the specific reason code (`GitHub 504 · last good read 14:32:08 · auto-reconnect in 6s`).

---

## 8. Route Structure

All view state in URL params so reload preserves state and the operator can share a deep link.

```
/monitor                          → board (default)
/monitor?lane=operator-review     → spotlight a lane (deep-linkable)
/monitor?card=agent%23548         → open drawer (deep-linkable; esc returns)
/monitor?search=foo               → filter the board
/monitor/mission/:id              → shareable mission report (drawer over still board)
```

---

## 9. Component Tree (load-bearing)

```
<MonitorPage>
  <TopStrip | TopStripDegraded>
    <BrandMark />
    <KPIPills />              // ACTION NEEDED · OPERATOR REVIEW · HERMES CHECKING · RELEASE QUEUE · DEPLOYING · DEPLOY OK
    <LiveIndicator />
    <Refresh />
  </TopStrip>

  <BoardNowBanner>             // sage default; amber when action-needed ≥ 1
    <Eyebrow />                // "Board now · 14:32:08 utc · 1 action needed"
    <Headline />               // "1 card needs Pascal's review decision..."
    <Sub />
    <PrimaryActions />         // [Jump to #548] [Ask Hermes]
  </BoardNowBanner>

  <BoardLayout>                // grid: mini-rail-left | board | mini-rail-right | hermes-rail
    <MiniRail side="left" />   // collapsed lanes
    <Board>
      {expandedLanes.map(lane => (
        <Lane key={lane.id} {...lane}>
          {lane.cards.map(card => <CardByType key={card.id} card={card} />)}
        </Lane>
      ))}
    </Board>
    <MiniRail side="right" />
    <CoPilotRail>
      <HermesNarration />[]
      <HermesTurn />[]
      <AskHermesComposer />
      <KeyboardHints />        // collapsed; ? expands
    </CoPilotRail>
  </BoardLayout>

  <DetailDrawer />             // portal; opens when ?card= set; type-routes to PRDrawer / MissionDrawer / etc.
  <NotificationBus />          // toasts, tab badge, desktop notifications, audio
</MonitorPage>
```

**Lane sizing algorithm** (runs once per render of `<Board>`):

```ts
const totalUnits = lanes.reduce((s, l) => s + Math.max(l.cards.length, 0.5), 0);
const totalAvailable = boardWidth - hermesRailWidth - leftRailWidth - rightRailWidth;
lanes.forEach(l => {
  l.width = (Math.max(l.cards.length, 0.5) / totalUnits) * totalAvailable;
});
// Lanes whose width < 100px collapse to the appropriate mini-rail.
// Done lane has a maximum width cap (avoid 16-card done lane eating the board).
```

---

## 10. Visual System / Design Tokens

**Critical contract:** never write a hex value inside a component. If a token doesn't exist for the color you need, add the token in the same PR.

Tokens are defined in two files (both in the bundle):

### `averray-tokens.css` (already in production — operator + marketing)

```css
:root {
  /* Palette — operator (warm beige, paper cream) */
  --avy-bg:          #f3f1ea;        /* page canvas */
  --avy-paper:       rgba(255, 253, 247, 0.88);
  --avy-paper-solid: #fffdf7;
  --avy-paper-alt:   #f7f9fa;
  --avy-ink:         #111315;
  --avy-muted:       #5f655f;
  --avy-line:        rgba(17, 19, 21, 0.12);
  --avy-line-soft:   rgba(17, 19, 21, 0.08);

  --avy-accent:      #1e6642;        /* sage primary */
  --avy-accent-2:    #0f6b4f;
  --avy-accent-soft: #d6eadf;
  --avy-accent-wash: rgba(30, 102, 66, 0.10);

  --avy-warm:        #f1d8b8;
  --avy-warn:        #a76122;
  --avy-warn-soft:   #f4e3cf;

  /* Type */
  --font-display: "Space Grotesk", "Manrope", ui-sans-serif, system-ui, sans-serif;
  --font-body:    "Manrope", ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono:    "JetBrains Mono", "SFMono-Regular", "Menlo", "Monaco", ui-monospace, monospace;

  --fs-h1: clamp(2.1rem, 3.8vw, 3.6rem);
  --fs-h2: clamp(1.6rem, 2vw, 2.2rem);
  --fs-h3: 1.12rem;
  --fs-eyebrow: 0.78rem;
  --fs-body: 1rem;
  --fs-small: 0.88rem;
  --fs-tiny:  0.76rem;

  /* Radii */
  --radius-sm: 6px;
  --radius:    8px;
  --radius-pill: 999px;

  /* Motion */
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);
  --dur-fast: 160ms;
  --dur:      180ms;
}
```

### `hermes.css` overlay (monitor-specific)

```css
:root {
  /* Surfaces — warmer than --avy-bg; monitor has its own paper rhythm */
  --hm-paper:       #fffdf7;
  --hm-paper-2:     #faf7ee;
  --hm-paper-3:     #f5f1e3;
  --hm-rail:        #efebde;
  --hm-rail-strong: #e8e3d2;

  --hm-ink:         #111315;
  --hm-ink-soft:    #2c2f31;
  --hm-muted:       #5e635a;        /* A8: bumped from #6c7068; 5.5:1 on cream */
  --hm-muted-soft:  #767870;        /* A8: bumped from #8d8f86; 4.5:1 on cream */
  --hm-line:        rgba(17,19,21,0.10);
  --hm-line-soft:   rgba(17,19,21,0.06);
  --hm-line-strong: rgba(17,19,21,0.18);

  /* Sage (success / verdict) */
  --hm-sage:        #1e6642;
  --hm-sage-deep:   #134b30;        /* AAA text on sage-wash */
  --hm-sage-soft:   #d6eadf;
  --hm-sage-wash:   #e9f1e9;

  /* Hermes (slightly bluer/teal sage — must NOT read as "passed") */
  --hm-hermes:      #0f6b5a;
  --hm-hermes-deep: #074a3e;
  --hm-hermes-soft: #d2e8e2;

  /* Amber (action / urgency) */
  --hm-amber:       #a76122;
  --hm-amber-deep:  #7d4615;
  --hm-amber-soft:  #f4e3cf;
  --hm-amber-wash:  #faecd6;
  --hm-amber-ring:  rgba(167, 97, 34, 0.32);

  /* Specialty */
  --hm-clay:        #c98a55;
  --hm-blue:        #254e9a;
  --hm-blue-soft:   #dee5f4;
  --hm-rose:        #a23a3a;        /* failed-fetch / disconnected */
  --hm-rose-soft:   #f2dad6;
  --hm-offline:      #5a5e5a;       /* source-offline; neutral, no urgency */
  --hm-offline-soft: #d6d8d0;

  --hm-stale:       #a59f8e;
  --hm-fresh:       #1e6642;

  /* Shadows */
  --hm-shadow-card:    0 1px 0 rgba(17,19,21,0.04), 0 8px 24px rgba(34,43,36,0.06);
  --hm-shadow-pop:     0 24px 60px rgba(34,43,36,0.16), 0 0 0 1px rgba(17,19,21,0.06);
  --hm-shadow-action:  0 0 0 1px var(--hm-amber-ring), 0 12px 28px rgba(167,97,34,0.18), 0 1px 0 rgba(167,97,34,0.10);

  --hm-radius:    10px;
  --hm-radius-sm: 6px;
  --hm-radius-lg: 14px;
}
```

**A8 a11y notes** (from the designer's receipts artboard):

- `--hm-muted` bumped from `#6c7068` to `#5e635a` to reach 5.5:1 on cream.
- `--hm-muted-soft` bumped from `#8d8f86` to `#767870` for 4.5:1.
- Hermes accent uses a distinct bluer-sage `#0f6b5a` to prevent "Hermes spoke" from reading as "this passed" — accessibility for color-vision differences and visual disambiguation.
- All foreground/background pairs verified against WCAG AA; sage-on-sage-wash hits AAA.

---

## 11. Interaction Patterns

| Surface | Trigger | Behavior |
|---|---|---|
| Card | click | Sets `?card=`, opens drawer (portal). Scrim layered over board. |
| Card | hover | Subtle lift via `--hm-shadow-card` → `--hm-shadow-pop`. |
| Lane | click header | Toggle collapse / expand. Persists in URL via `?lanes=`. |
| Lane | "collapse ‹" click | Minimize to vertical mini-rail. |
| Mini-rail | click | Expand the lane it represents. |
| Drawer | `esc` | Close, restore focus to triggering card. |
| Drawer | scrim click | Close (same as esc). |
| Drawer | `j` / `k` | Prev / next card within current visible scope. |
| Drawer | `↵` on primary action | Trigger the primary action. |
| Search | `/` | Focus the input. |
| Hermes composer | `↵` | Send. `↑` / `↓` history. |
| Help overlay | `?` | Toggle. `esc` or click dismiss to close. |
| Spotlight | `f` on focused card | Collapse every lane except the focused card's lane + Done. |

**Focus restore contract:** closing the drawer must restore focus to the card that opened it. Capture a ref on open; restore on close. Use `focus-trap-react` (or equivalent) inside the drawer.

---

## 12. Keyboard Map

`app/lib/monitor/keyboard-map.ts` is the single source of truth — the cheat-sheet overlay reads from it. **Wired in the prototype:** `j` `k` `↓` `↑` `Enter` `Escape` `?` `/` `f`. **Specced for v1 implementation but not in the prototype:** `o` (open PR on GitHub), `a` (Ask Hermes about focused card), and the drawer-internal action shortcuts. Engineering wires the missing ones.

```ts
export const KEYBOARD_MAP = {
  global: {
    "?":      "toggle_keyboard_overlay",
    "/":      "focus_search",
    "Escape": "close_drawer_or_overlay",
  },
  board: {
    "j":         "focus_next_card",
    "ArrowDown": "focus_next_card",
    "k":         "focus_prev_card",
    "ArrowUp":   "focus_prev_card",
    "Enter":     "open_drawer_for_focused",
    "o":         "open_pr_for_focused",           // NEW — wire in v1
    "a":         "ask_hermes_about_focused",      // NEW — wire in v1
    "f":         "spotlight_focused_lane",
  },
  drawer: {
    "j":     "drawer_next_card",
    "k":     "drawer_prev_card",
    "Enter": "drawer_primary_action",             // context-sensitive
    "A":     "drawer_action_approve",             // explicit per-action where ambiguous
    "B":     "drawer_action_send_back",
    "R":     "drawer_action_rerun_fresh",         // missions
    "M":     "drawer_action_rerun_memory",        // missions
    "C":     "drawer_copy_report",                // missions
  },
  hermes: {
    "Enter":     "hermes_send_message",
    "ArrowUp":   "hermes_history_prev",
    "ArrowDown": "hermes_history_next",
  },
} as const;
```

**Input-focus rule:** when an `<input>` or `<textarea>` owns focus, only `Escape` is honored (it blurs). Everything else is for the parent surface.

---

## 13. Animation & Motion

All animations honor `prefers-reduced-motion: reduce` → downgrade to instant.

| Event | Pattern | Duration | Notes |
|---|---|---|---|
| Lane collapse / expand | Width + opacity transition | `--dur` (180ms) | Ease via `--ease`. |
| Card moves between lanes | Brief highlight + slide | `--dur` | One-shot. Do not loop. |
| Card receives an update | Background pulse | `--dur-fast` (160ms) | Signals "this just changed." |
| Action-needed card breathing | 4s slow opacity pulse on `--hm-amber-wash` | indefinite | **Only when** `needs-attention` lane has exactly 1 card. Subtle (2–4% opacity oscillation). Disable on 0 or ≥2 cards. |
| Drawer open / close | Slide + scrim fade | `--dur` | Ease-out open, ease-in close. |
| Hermes new turn | Slide-in from bottom of rail | `--dur-fast` | Auto-scroll the rail. |
| Stream disconnect | LIVE indicator → rose; reconnect spinner | `--dur-fast` | No layout shift. |

---

## 14. Accessibility

This is a 10-hour-per-day tool. Get this right.

- **WCAG AA contrast minimum** on all text. The bundle's a11y artboard (A8) measures every pair; engineering's job is to not regress it.
- **Keyboard navigable end-to-end.** Acceptance test: unplug the mouse and complete a full board → drawer → mission spawn → Hermes question flow.
- **Screen-reader landmarks:** TopStrip is `role="banner"`, each lane is `role="region" aria-label="<lane name>"`, drawer is `role="dialog" aria-modal="true" aria-labelledby="…"`, Hermes rail is `role="complementary" aria-label="Hermes co-pilot"`.
- **Focus visible:** custom focus ring (sage outline, 2px, 2px offset). The bundle's CSS already defines this on `:focus-visible`.
- **Live regions:** BoardNowBanner is `aria-live="polite"`. Hermes rail is `aria-live="polite" aria-atomic="false"`. Action-needed lane transitions from 0 → ≥1 fire an `aria-live="assertive"` announcement once.
- **Color is never the only signal.** Urgency = background tint + thin amber border + icon. Stale = fade + "stale Xm" badge. Failed-fetch = rose ribbon + retry button + reason code text.

---

## 15. Performance Budgets

This tool stays open all day. Memory leaks and runaway re-renders will be noticed.

- **First contentful paint:** ≤ 1.2s on a warm cache (post-auth load).
- **Time-to-interactive:** ≤ 2s.
- **Live update render budget:** ≤ 16ms per SSE event. Up to ~30 visible cards; never re-render all of them on a single-card update — use stable keys and memoization.
- **Hermes rail max retained turns:** 200. Paginate older turns; lazy-fetch on scroll-up.
- **Done lane max retained:** 50 cards. Auto-archive policy lives server-side; frontend renders what arrives.
- **SSE reconnect ceiling:** 30s max backoff. No infinite-grow timers.
- **Memory ceiling target:** ≤ 150MB heap after 8h of continuous use. Check with `performance.memory` in dev mode; fail an e2e test if exceeded.

---

## 16. Error & Degraded States

The bundle's `states.jsx` is the visual spec. Engineering responsibilities:

| Failure mode | Detection | UI response |
|---|---|---|
| SSE stream disconnected | `EventSource` error, or no heartbeat for 60s | LIVE indicator → rose. TopStrip swaps to `TopStripDegraded`: action-count KPIs show `?` (not `0`), header shows `Hermes — degraded mode` with last-good timestamp. UNTRUSTED banner with reason code (`GitHub 504 · last good 14:32:08 · auto-reconnect in 6s`). Cards retain last-known state; `state` flips to `failed-fetch` for any whose data is now stale. Reconnect button is prominent. |
| GitHub rate-limited | API 429 or 403 with rate-limit headers | Affected cards show "fresh data unavailable — rate limit resets in Xm" footer. Other lanes unaffected. Per-card state is `failed-fetch` with rose ribbon. |
| Hermes service offline | `/api/monitor/hermes/stream` 5xx for 30s | Co-pilot rail shows "Hermes is offline — narration paused" with a manual retry. Board continues working without narration. |
| Codex runner offline | Heartbeat older than 60s | Codex task cards show a "runner offline" badge using `--hm-offline`. New task spawns disabled with tooltip. |
| Browser-agent runtime offline | Mission spawn fails | "Mission runner offline" toast. Existing mission cards retain last status with a degraded indicator (grey, dashed border per A7's `source-offline` variant). |
| Full backend down | `/api/monitor/board` 5xx on initial load | Top-level error boundary: "Monitor backend is unreachable — last successful board state from Xm ago." Show cached data from localStorage if available; otherwise the error screen. |
| Stale tab (user returned after 1h) | `document.visibilitychange` to `visible` + stream stale | Force fresh `/api/monitor/board` fetch. Show a soft "catching up…" toast. |

**Hard rule (from A7):** zero tolerance for hiding "we don't know if there's action needed." When the stream is down, KPI counts show `?`, not the last cached number. The operator must always see *why* something didn't load — never silent staleness.

---

## 17. Notifications & Alerts

Three tiers, complementary:

1. **In-app audio + visual.** When `needs-attention` count goes 0 → ≥1 AND `document.visibilityState === "visible"`: short soft tone (<200ms); BoardNowBanner flashes sage → amber once. Operator can mute for N hours via the Hermes co-pilot.
2. **Browser tab badge + title.** `document.title = "(N) Hermes — Averray"` when action count changes. Canvas-rendered favicon with the numeric badge (use the Badging API where supported as a progressive enhancement).
3. **Desktop notification.** On 0 → ≥1 transition AND `document.visibilityState === "hidden"`: send a `Notification` with the card title + "review needed." Request permission on first use via a soft in-app prompt — never trigger the browser permission dialog unprompted.

**Mute settings** (operator can ask Hermes via natural language):
- "Mute alerts for 1 hour"
- "Mute alerts until tomorrow 9am"
- "Mute alerts for this card only"

Storage: localStorage with TTL per mute. Re-evaluate on every tab open.

---

## 18. Testing Strategy

Match existing project conventions (`node:test` + JSDoc-typed pure modules + React components separately).

### Unit (`app/lib/monitor/*.test.mjs`)

- `lane-rules.test.mjs` — every card type × every state → expected lane.
- `urgency.test.mjs` — freshness math, stale thresholds, edge cases (missing timestamps, future timestamps).
- `board-state.test.mjs` — selectors (cards by lane, lane counts, KPI strip computations).
- `keyboard-map.test.mjs` — every shortcut maps to a defined action; no duplicates per scope.
- `live-stream.test.mjs` — reconnect backoff, event ordering, dedup on reconnect catch-up.
- `notifications.test.mjs` — title-update math, badge-count edges, mute TTL.

### Component (Playwright or React Testing Library)

- Card renders correctly per type variant × state variant (full matrix from A7 — 4 types × 5 states = 20 visual regression cases).
- Drawer opens/closes on click; focus restores correctly.
- Lane collapse / expand persists in URL params.
- Keyboard nav: `j`/`k` traversal, `↵` opens drawer, `esc` closes, `/` focuses search, `f` spotlights lane.

### Integration / e2e (Playwright against a mocked SSE backend)

- Full board → click action card → drawer opens → approve → drawer closes → card moves to release queue → SSE confirms move within 500ms.
- SSE disconnect → LIVE indicator goes rose → degraded TopStrip with `?` counts → reconnect → all state catches up.
- Action-needed lane 0 → 1 → desktop notification fires when tab hidden; tab badge + title update when visible.
- Spawn mission via Ask Hermes `/mission ...` → mission card appears → click → MissionDrawer opens → live-updating progress arrives via SSE.

### Acceptance (manual, operator)

Sit with the operator for one full shift after launch. Note every moment they have to read instead of glance. This is the only test that validates the redesign actually solved the original pain.

---

## 19. Observability & Telemetry

- **Frontend logs:** structured JSON via the existing `requestLogger` pattern. Log SSE reconnects, render-budget violations (frame > 100ms), and error-boundary catches.
- **Telemetry events:**
  - `monitor.board.viewed` — once per session
  - `monitor.card.opened` — `{ cardType, lane }`
  - `monitor.card.action` — `{ cardType, action }`
  - `monitor.hermes.question` — `{ scope }` (focused card or global)
  - `monitor.mission.spawned` — `{ url, mode }`
  - `monitor.notification.sent` — `{ trigger }`
  - `monitor.stream.disconnected` — `{ reason, duration }`
- **Error capture:** existing Sentry / structured-log fallback from `OBSERVABILITY_POSTURE.md`. The error boundary in `app/app/(authed)/monitor/error.tsx` captures and reports.
- **Operator self-coaching metrics:** the monitor itself exposes (in a settings panel) avg time-to-decision today, missed alerts (action-needed unattended > 30 min), and stream uptime.

---

## 20. Build & Deploy

- Reuses the existing operator-app build pipeline: `npm run build:frontend` (static export) already covers the new route group.
- The CI `Operator app — static export` job already covers it; no new CI job needed.
- New env var (if Hermes runs at a different origin): `MONITOR_HERMES_API_URL`. Currently same-origin via `mcp-server`, so none required.
- Caddy / nginx: no changes; same-origin everything.
- Generated `frontend/` output guard applies (per AGENTS.md): never commit regenerated frontend chunks. CI handles the build on merge.

---

## 21. Decisions Made

The seven questions originally posed in this section were resolved with the operator on 2026-05-27 (before M4 started). The implementation milestones below build against these decisions; later milestones that depend on a decision are flagged.

1. **`document.title` update strategy** — **Direct mutation via `useEffect`** in a small top-level `TitleBadge` component. The app ships as a Next.js static export; runtime-changing title values are incompatible with the build-time metadata API. App-router supports a dynamic title via metadata, but for a value that changes on every action-count delta a one-line `useEffect(() => { document.title = …; }, [count])` is simpler and more reliable. **Used by:** M8.

2. **Favicon badge rendering** — **Canvas-rendered swap, with Badging API as progressive enhancement.** Canvas works on every browser: draw a small circle with the count, encode as `data:image/png`, swap the `<link rel="icon">`. Additionally feature-detect `navigator.setAppBadge` and call it where supported — gives Chromium users the OS-level dock badge. ~30 lines total. **Used by:** M8.

3. **Audio asset for the alert tone** — **Procedural Web Audio API tone**. Soft sine-wave chime, 200ms duration, exponential decay. ~10 lines, no asset file, no licensing, deterministic across browsers. M8 also wires a settings hook so the operator can swap to an uploaded audio file later. **Used by:** M8.

4. **Snapshot data retention** — **`localStorage` with 24h sliding TTL**, key shape `monitor.snapshot.<isoTimestamp>`. The data exists from M4 onward but no UI surfaces it yet (time-travel UI deferred to v1.1). The key shape lets a future time-travel page-back through stored snapshots without a migration. **Used by:** M4 (write); v1.1 (read).

5. **Mission-spawn auth boundary** — **Admin role OR new `mission-operator` role.** Anyone authed can view missions; spawning requires `roles: ["admin"]` OR `roles: ["mission-operator"]`. The new role goes into `VALID_ROLES` in the auth config. Today the operator (admin) is the only caller; tomorrow the operator can delegate mission running to a team member without giving them full admin. Reuses the existing `AdminAuth` middleware pattern with a widened allow-list. **Used by:** M6.

6. **Multi-repo support** — **Single repo now, design API for multi-repo later.** `/api/monitor/board` returns cards for the single configured `AVERRAY_REPO` (env var), but every card carries a `repo: string` field in the response. The TopStrip's REPO filter renders as a static single-repo label in M4 — becomes a real dropdown the day the server starts aggregating across N configured repos. No client migration when that happens; only the server-side aggregator changes. **Used by:** M4.

7. **Card-relationships data model** — **Fully deferred to v1.1.** The platform does not track "PR X waits on PR Y" today; designing the data shape ahead of the platform feature is premature. Open a fresh ADR when the dependency graph is real. **Used by:** v1.1.

---

## 22. Phased Milestones (PR breakdown)

One narrow PR per milestone, one branch per PR (matching `AGENTS.md` rules). Each independently mergeable.

| PR | Title | Scope | Acceptance |
|---|---|---|---|
| **M1** | `monitor: scaffold + data model + lane rules` | File structure, types, pure-logic modules, tests. No UI. | `npm run test:app` covers lane-rules + urgency + board-state. |
| **M2** | `monitor: top strip + Board Now banner + empty board layout` | Static layout, no live data. | Renders the empty board with placeholder copy. |
| **M3** | `monitor: card components per type + states sheet variants` | 6 card types × 5 state variants. No SSE. | Visual regression suite (Playwright snapshots) matches A1/A7 designs. |
| **M4** | `monitor: live data wiring (SWR + SSE)` | `/api/monitor/board` + `/api/monitor/stream` + reconnect. | E2E: mock card via API → appears within 500ms. |
| **M5** | `monitor: detail drawer (PR + Codex + Deploy variants)` | Click card → drawer; esc closes; focus restores. | All §11 / §12 keyboard interactions. |
| **M6** | `monitor: browser mission drawer + spawn flow` | A6 wired; `/mission` slash command in Ask Hermes. | E2E: spawn via Ask Hermes → mission card → progress updates live via SSE. |
| **M7** | `monitor: Hermes co-pilot rail` | Card-stream narration, composer, focused-card scoping. | E2E: ask about focused card → reply scoped. |
| **M8** | `monitor: notifications + tab badge + audio alert` | All three tiers from §17 + mute settings. | Manually verified across Chrome / Safari / Firefox. |
| **M9** | `monitor: keyboard shortcuts + overlay` | Full §12 map wired (including the `o` and `a` shortcuts not in the prototype) + `?` overlay. | Operator completes a full shift without touching the mouse. |
| **M10** | `monitor: degraded states + error boundaries + accessibility pass` | All §16 failure modes; §14 a11y compliance. | WCAG AA audit clean; SSE-down e2e passes. |

**Rough sizing:** M1 ~ 1 day (tokens already shipped via `averray-tokens.css`), M2–M4 ~ 1–2 days each, M5–M7 ~ 2–3 days each, M8–M10 ~ 1–2 days each. Total: ~2.5 weeks for one focused engineer.

---

## 23. Definition of Done (operator-shippable)

- All 10 milestones merged.
- WCAG AA audit clean.
- One full operator shift used the prototype with zero "I had to read instead of glance" moments on the action-needed signal.
- SSE disconnect → reconnect → catch-up works end-to-end.
- Browser missions spawn, run, and report through the MissionDrawer.
- Notifications fire on the action-needed transition in all three tiers, on a quiet tab.
- The "Error update failed" pill from the old monitor is replaced by something that says exactly *what* failed and *what to do about it*.

---

## Appendix A — Bundle Inventory Cross-Check

What the bundle ships, what engineering ports, what engineering originates:

| Item | Bundle | Port verbatim? | Notes |
|---|---|---|---|
| Token system | `averray-tokens.css` + `hermes.css` | Yes — copy both into `app/styles/` (or import) | Already production-reconciled. |
| TopStrip component | `components.jsx` | Visual only; restructure for React/Next.js conventions | The prototype is React-flavored; engineering ports to TypeScript + proper component split. |
| BoardNowBanner | `components.jsx` | Visual only | Tone variants (sage/amber) per banner mode. |
| Lane + Card + CardShell | `components.jsx` | Visual only | Type variants split into separate files (see §5). |
| DetailDrawer (PR variant) | `components.jsx` | Visual only | Engineering wires the focus-trap and route-param sync. |
| MissionDrawer | `components.jsx` + A6 artboard | Visual only | The mission data shape is in `data.jsx`. |
| States sheet (all degraded variants) | `states.jsx` + A7 artboard | Visual only | Engineering wires the actual triggers (SSE error → degraded TopStrip). |
| Keyboard wiring | `artboards.jsx`'s `onKey` handler | Use as reference; add `o` and `a` shortcuts in M9 | The bundle wires 9 keys; engineering adds 2 more per §12. |
| Fixture data | `data.jsx` | No — replace with real `/api/monitor/board` data | Useful as the test fixture for Playwright. |
| Audio asset | Not in bundle | N/A | Engineering picks per §21. |
| Favicon | Not in bundle | N/A | Engineering renders from brand mark per §21. |
| SSE/API contract | Not in bundle | N/A | Engineering implements per §5 + §7 in `mcp-server`. |

---

*End of spec. v1.0.*

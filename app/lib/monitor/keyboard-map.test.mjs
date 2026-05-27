// Tests for keyboard-map.js — keyboard contract for the Hermes
// Handoff Monitor. M1 milestone. Locks the contract early so M2-M9
// can't accidentally drift the cheat sheet away from the handlers.

import test from "node:test";
import assert from "node:assert/strict";

import {
  KEYBOARD_BINDINGS,
  bindingsForScope,
  visibleBindings,
} from "./keyboard-map.js";

// ── Structural invariants ───────────────────────────────────────────

test("every binding has a key, action, label, and scope", () => {
  for (const b of KEYBOARD_BINDINGS) {
    assert.ok(typeof b.key === "string" && b.key.length > 0, `bad key: ${JSON.stringify(b)}`);
    assert.ok(typeof b.action === "string" && b.action.length > 0, `bad action: ${JSON.stringify(b)}`);
    assert.ok(typeof b.label === "string" && b.label.length > 0, `bad label: ${JSON.stringify(b)}`);
    assert.ok(
      ["global", "board", "drawer", "hermes"].includes(b.scope),
      `unknown scope: ${JSON.stringify(b)}`
    );
  }
});

test("KEYBOARD_BINDINGS is frozen (cannot be mutated at runtime)", () => {
  assert.equal(Object.isFrozen(KEYBOARD_BINDINGS), true);
});

// ── Per-scope uniqueness ────────────────────────────────────────────

test("each (scope, key) pair appears at most once", () => {
  const seen = new Set();
  for (const b of KEYBOARD_BINDINGS) {
    const id = `${b.scope}::${b.key}`;
    assert.ok(!seen.has(id), `duplicate binding for ${id}`);
    seen.add(id);
  }
});

test("an action can be aliased to multiple keys within a scope (j + ArrowDown both dispatch focus_next_card), but never spans scopes", () => {
  // An action like focus_next_card should fire from both `j` and
  // `ArrowDown` (mouse-free operators expect both). But the SAME
  // action id appearing under two different scopes would mean the
  // handler can't tell which scope's binding fired — that's a bug.
  /** @type {Map<string, string>} */
  const actionToScope = new Map();
  for (const b of KEYBOARD_BINDINGS) {
    const seenScope = actionToScope.get(b.action);
    if (seenScope === undefined) {
      actionToScope.set(b.action, b.scope);
    } else {
      assert.equal(
        seenScope,
        b.scope,
        `action ${b.action} appears in both scope=${seenScope} and scope=${b.scope}; that's a contract bug`
      );
    }
  }
});

// ── Cross-scope key-collision sanity ────────────────────────────────

test("same key across scopes is allowed and intentional (j/k traverse both board and drawer)", () => {
  // This isn't a violation — it's the design. The handler must
  // pass the right scope when looking up. The test just documents
  // that we know this happens.
  const allKeys = KEYBOARD_BINDINGS.map((b) => `${b.scope}::${b.key}`);
  assert.ok(allKeys.includes("board::j"));
  assert.ok(allKeys.includes("drawer::j"));
  assert.ok(allKeys.includes("board::k"));
  assert.ok(allKeys.includes("drawer::k"));
});

// ── bindingsForScope ────────────────────────────────────────────────

test("bindingsForScope: returns the global scope only", () => {
  const map = bindingsForScope("global");
  assert.equal(map["?"], "toggle_keyboard_overlay");
  assert.equal(map["/"], "focus_search");
  assert.equal(map["Escape"], "close_drawer_or_overlay");
  assert.equal(Object.keys(map).length, 3);
});

test("bindingsForScope: returns the board scope (including unwired M9 entries)", () => {
  const map = bindingsForScope("board");
  assert.equal(map["j"], "focus_next_card");
  assert.equal(map["k"], "focus_prev_card");
  assert.equal(map["ArrowDown"], "focus_next_card");
  assert.equal(map["ArrowUp"], "focus_prev_card");
  assert.equal(map["Enter"], "open_drawer_for_focused");
  assert.equal(map["f"], "spotlight_focused_lane");
  // M9 entries — currently unwired but in the contract
  assert.equal(map["o"], "open_pr_for_focused");
  assert.equal(map["a"], "ask_hermes_about_focused");
});

test("bindingsForScope: drawer scope", () => {
  const map = bindingsForScope("drawer");
  assert.equal(map["j"], "drawer_next_card");
  assert.equal(map["Enter"], "drawer_primary_action");
  assert.equal(map["A"], "drawer_action_approve");
  assert.equal(map["B"], "drawer_action_send_back");
  assert.equal(map["R"], "drawer_action_rerun_fresh");
  assert.equal(map["M"], "drawer_action_rerun_memory");
  assert.equal(map["C"], "drawer_copy_report");
});

test("bindingsForScope: hermes scope", () => {
  const map = bindingsForScope("hermes");
  assert.equal(map["Enter"], "hermes_send_message");
  assert.equal(map["ArrowUp"], "hermes_history_prev");
  assert.equal(map["ArrowDown"], "hermes_history_next");
});

test("bindingsForScope: returns empty object for unknown scope", () => {
  // @ts-expect-error — exercising the unknown-scope path
  const map = bindingsForScope("does-not-exist");
  assert.deepEqual(map, {});
});

// ── visibleBindings ─────────────────────────────────────────────────

test("visibleBindings: with no options returns the full ordered list", () => {
  const visible = visibleBindings();
  assert.equal(visible.length, KEYBOARD_BINDINGS.length);
  // Order matches the source array
  for (let i = 0; i < visible.length; i++) {
    assert.equal(visible[i].action, KEYBOARD_BINDINGS[i].action);
  }
});

test("visibleBindings: wiredOnly filters to just the M1-wired shortcuts", () => {
  const visible = visibleBindings({ wiredOnly: true });
  // Every entry in the filtered list must have wired: true
  for (const b of visible) {
    assert.equal(b.wired, true, `wiredOnly should filter unwired bindings: ${b.action}`);
  }
  // And the M9 board entries (`o` and `a`) must NOT be present
  const actions = visible.map((b) => b.action);
  assert.ok(!actions.includes("open_pr_for_focused"), "o should be filtered by wiredOnly");
  assert.ok(!actions.includes("ask_hermes_about_focused"), "a should be filtered by wiredOnly");
});

// ── Specific M1 contract assertions ─────────────────────────────────

test("the eight keys wired by the prototype are all marked wired=true", () => {
  const wiredKeys = ["?", "/", "Escape", "j", "k", "ArrowDown", "ArrowUp", "Enter", "f"];
  for (const key of wiredKeys) {
    const matches = KEYBOARD_BINDINGS.filter(
      (b) => b.key === key && (b.scope === "global" || b.scope === "board")
    );
    assert.ok(matches.length >= 1, `expected at least one global/board binding for ${key}`);
    // At least one must be wired=true for the global/board scope.
    assert.ok(
      matches.some((b) => b.wired === true),
      `expected a wired=true binding for ${key} in global/board scope`
    );
  }
});

test("the M9 additions (o, a) are present but marked wired=false", () => {
  const o = KEYBOARD_BINDINGS.find((b) => b.scope === "board" && b.key === "o");
  const a = KEYBOARD_BINDINGS.find((b) => b.scope === "board" && b.key === "a");
  assert.ok(o, "binding for 'o' must exist");
  assert.ok(a, "binding for 'a' must exist");
  assert.equal(o.wired, false);
  assert.equal(a.wired, false);
});

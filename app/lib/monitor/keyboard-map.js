/**
 * Hermes Handoff Monitor — keyboard shortcuts contract.
 *
 * Single source of truth for every keyboard binding the monitor
 * accepts. The cheat-sheet overlay reads this directly so what the
 * operator sees is what the handlers actually listen for.
 *
 * Three scopes — `global`, `board`, `drawer`, `hermes`. Per the spec,
 * an input/textarea claiming focus suppresses every scope except
 * `Escape` (which blurs the input).
 *
 * Per §12 of docs/HERMES_MONITOR_REDESIGN_SPEC.md.
 */

/**
 * @typedef {"global" | "board" | "drawer" | "hermes"} ShortcutScope
 */

/**
 * @typedef {Object} ShortcutBinding
 * @property {string} key       — the KeyboardEvent.key value to match
 * @property {string} action    — symbolic action id the handler dispatches
 * @property {string} label     — operator-facing description for the overlay
 * @property {ShortcutScope} scope
 * @property {boolean} [wired]  — true if M1 prototype already wires it;
 *                                 false if specced but added in a later
 *                                 milestone. Used by tests to assert
 *                                 the cheat sheet matches reality.
 */

/**
 * Ordered list of every binding. Order is the order the cheat-sheet
 * overlay renders.
 *
 * @type {readonly ShortcutBinding[]}
 */
export const KEYBOARD_BINDINGS = Object.freeze([
  // ── Global ───────────────────────────────────────────────
  { key: "?",      action: "toggle_keyboard_overlay", label: "toggle keyboard hints",   scope: "global", wired: true },
  { key: "/",      action: "focus_search",            label: "jump to search",          scope: "global", wired: true },
  { key: "Escape", action: "close_drawer_or_overlay", label: "close drawer / overlay",  scope: "global", wired: true },

  // ── Board ────────────────────────────────────────────────
  { key: "j",         action: "focus_next_card",          label: "next card",            scope: "board", wired: true },
  { key: "ArrowDown", action: "focus_next_card",          label: "next card (arrow)",    scope: "board", wired: true },
  { key: "k",         action: "focus_prev_card",          label: "previous card",        scope: "board", wired: true },
  { key: "ArrowUp",   action: "focus_prev_card",          label: "previous card (arrow)",scope: "board", wired: true },
  { key: "Enter",     action: "open_drawer_for_focused", label: "open focused card",    scope: "board", wired: true },
  { key: "f",         action: "spotlight_focused_lane",   label: "focus / spotlight lane",scope: "board", wired: true },
  // M9 additions — specced in v1, wired in milestone M9 per spec.
  { key: "o",         action: "open_pr_for_focused",      label: "open PR on GitHub",    scope: "board", wired: false },
  { key: "a",         action: "ask_hermes_about_focused", label: "ask Hermes about focused card", scope: "board", wired: false },

  // ── Drawer ───────────────────────────────────────────────
  { key: "j",     action: "drawer_next_card",       label: "next card (in drawer)",     scope: "drawer", wired: false },
  { key: "k",     action: "drawer_prev_card",       label: "previous card (in drawer)", scope: "drawer", wired: false },
  { key: "Enter", action: "drawer_primary_action",  label: "trigger primary action",    scope: "drawer", wired: false },
  { key: "A",     action: "drawer_action_approve",  label: "approve",                   scope: "drawer", wired: false },
  { key: "B",     action: "drawer_action_send_back",label: "send back to Codex",        scope: "drawer", wired: false },
  { key: "R",     action: "drawer_action_rerun_fresh",  label: "rerun fresh (missions)", scope: "drawer", wired: false },
  { key: "M",     action: "drawer_action_rerun_memory", label: "rerun with memory",     scope: "drawer", wired: false },
  { key: "C",     action: "drawer_copy_report",     label: "copy report",               scope: "drawer", wired: false },

  // ── Hermes co-pilot composer ─────────────────────────────
  { key: "Enter",     action: "hermes_send_message", label: "send message",          scope: "hermes", wired: false },
  { key: "ArrowUp",   action: "hermes_history_prev", label: "previous question",     scope: "hermes", wired: false },
  { key: "ArrowDown", action: "hermes_history_next", label: "next question",         scope: "hermes", wired: false },
]);

/**
 * Build a `{ [key]: action }` lookup for a single scope. The handler
 * code uses these maps directly: read e.key, look it up, dispatch.
 *
 * Note: the same physical key can map to different actions in
 * different scopes (e.g. `j` traverses cards on the board AND
 * traverses cards inside the drawer). Scope-disambiguation is the
 * caller's job — pass the right map for the active context.
 *
 * @param {ShortcutScope} scope
 * @returns {Record<string, string>}
 */
export function bindingsForScope(scope) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const b of KEYBOARD_BINDINGS) {
    if (b.scope === scope) out[b.key] = b.action;
  }
  return out;
}

/**
 * The cheat-sheet overlay reads this. Returns the bindings in display
 * order, optionally filtered to only-wired bindings (so milestone-1
 * builds don't show a cheat sheet entry for shortcuts that don't
 * actually do anything yet).
 *
 * @param {{ wiredOnly?: boolean }} [opts]
 * @returns {ShortcutBinding[]}
 */
export function visibleBindings(opts = {}) {
  if (opts.wiredOnly) {
    return KEYBOARD_BINDINGS.filter((b) => b.wired);
  }
  return [...KEYBOARD_BINDINGS];
}

/**
 * The draft check — the truth boundary, applied to prose.
 *
 * Everything upstream vetoes a *claim*: a structured assertion with a field
 * behind it. This checks the *sentences written around* that claim, which is a
 * different and softer surface, and the one an LLM can reach past.
 *
 * The claim "Merged: measure both sides of the x402 rail" is true. So is every
 * figure in the pull request. And "agents are already earning on Averray" is a
 * sentence somebody could write next to both of them without noticing they had
 * invented it. Nothing upstream would object, because no claim changed.
 *
 * So this checks the text itself, mechanically, against what the payload and
 * the source material actually support. It is deliberately blunt: a rejected
 * draft costs one regeneration, a false public claim costs the thing the whole
 * account trades on. When those two are in tension, reject.
 *
 * Used by the drafter before any variant is published, and equally valid for a
 * human's own words — nothing here knows or cares who wrote the text.
 */

export const DRAFT_VIOLATIONS = Object.freeze({
  EXTERNAL_ACTIVITY: "claims-external-activity",
  UNVERIFIED_DEPLOY: "claims-deployed",
  UNSOURCED_NUMBER: "unsourced-number"
});

/**
 * Words that assert outside participation. Checked as whole words so
 * "externally" or a URL containing "agent" cannot trip them.
 */
const EXTERNAL_PATTERNS = [
  /\bexternal agents?\b/iu,
  /\boutside agents?\b/iu,
  /\bthird[- ]party agents?\b/iu,
  /\bother agents?\b/iu,
  /\bagents are (?:earning|working|using|picking up)\b/iu
];

/** Words that assert a change is running in production. */
const DEPLOY_PATTERNS = [
  /\bshipped\b/iu,
  /\blaunched\b/iu,
  /\breleased\b/iu,
  /\bnow live\b/iu,
  /\bis live\b/iu,
  /\bwent live\b/iu,
  /\bin production\b/iu,
  /\bnow available\b/iu
];

/**
 * Every digit-run in the text, normalised for comparison.
 *
 * Thousands separators are stripped so "19,290,804" and "19290804" compare
 * equal, and a trailing decimal point is dropped so a sentence-ending "0.202."
 * does not read as a different number from "0.202".
 */
export function numbersIn(text) {
  const matches = String(text ?? "").match(/\d[\d,.]*/gu) ?? [];
  return matches
    .map((raw) => raw.replace(/,/gu, "").replace(/\.$/u, ""))
    .filter((n) => n.length > 0);
}

/**
 * A number is supported when its digits appear anywhere in the source material
 * or the observed reading.
 *
 * Substring rather than equality on purpose: the source may say "0.202%" while
 * the draft says "0.202", or "95 postings" while the draft says "95". What this
 * catches is the number that appears in NEITHER — the invented one.
 *
 * Small integers are exempt. "one of two things", "3 postings" and "the first"
 * are ordinary prose, and demanding a source for every "2" would make the check
 * fire constantly, which is how a check stops being read.
 */
const SMALL_NUMBER_CEILING = 10;

export function unsourcedNumbers(text, sources = []) {
  const haystack = sources.map((s) => String(s ?? "").replace(/,/gu, "")).join("\n");
  return numbersIn(text).filter((n) => {
    const asNumber = Number(n);
    if (Number.isFinite(asNumber) && Math.abs(asNumber) <= SMALL_NUMBER_CEILING && !n.includes(".")) {
      return false;
    }
    return !haystack.includes(n);
  });
}

/**
 * Check one draft variant. Returns the violations; empty means publishable.
 *
 * `observed` is the transparency reading the signal fired against; `sources`
 * are the strings the draft is allowed to draw figures from (the claim, the
 * author's summary, the observed values).
 */
export function checkDraft(text, { observed = {}, sources = [], deployVerified = null } = {}) {
  const violations = [];
  const draft = String(text ?? "");

  // Only when the payload actually says zero, and says it freshly. A stale
  // reading is not grounds to accuse a draft of anything.
  const external = observed["flow.composition24h.external"];
  if (external && external.status === "fresh" && Number(external.value) === 0) {
    const hit = EXTERNAL_PATTERNS.find((p) => p.test(draft));
    if (hit) {
      violations.push({
        reason: DRAFT_VIOLATIONS.EXTERNAL_ACTIVITY,
        detail: `matched ${hit} while composition24h.external is 0 — any reader can check the same endpoint`
      });
    }
  }

  if (deployVerified === false) {
    const hit = DEPLOY_PATTERNS.find((p) => p.test(draft));
    if (hit) {
      violations.push({
        reason: DRAFT_VIOLATIONS.UNVERIFIED_DEPLOY,
        detail: `matched ${hit} but the merge commit was never verified as deployed — merged is not shipped`
      });
    }
  }

  const invented = unsourcedNumbers(draft, [
    ...sources,
    ...Object.values(observed).map((f) => String(f?.value ?? ""))
  ]);
  if (invented.length > 0) {
    violations.push({
      reason: DRAFT_VIOLATIONS.UNSOURCED_NUMBER,
      detail: `figures with no source: ${invented.join(", ")}`
    });
  }

  return violations;
}

/** Split surviving variants from rejected ones, keeping the reasons. */
export function screenVariants(variants = [], context = {}) {
  const passed = [];
  const rejected = [];
  for (const variant of variants) {
    const text = typeof variant === "string" ? variant : variant?.text;
    if (!text || !text.trim()) continue;
    const violations = checkDraft(text, context);
    if (violations.length === 0) passed.push(text.trim());
    else rejected.push({ text: text.trim(), violations });
  }
  return { passed, rejected };
}

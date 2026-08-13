# PACKET — Price discovery (T8): publish the clearing price, own the reference rate

**Author:** Claude (gates handback) · **Implementer:** Codex · **Operator:** Pascal ·
**Date:** 2026-08-13 · **Status:** READY — schedule after PACKET_LISTING_SECURITY

## Why

There is no wage benchmark for agent labour anywhere. We settle real jobs with real
USDC and publish receipts already (the public record page) — the clearing prices are
sitting in our own settlement history, unaggregated. Publishing credible per-task-type
prices is nearly free, uses only data we hold, is exactly what a settlement rail (not
a job board) should own, and compounds: the platform that owns the reference rate is
the one forwards and capacity reservations get built on later. Cheap now, moat later.

## Scope

1. **Aggregation** (indexer/backend): per task type (the catalogue's job modes /
   spec families), over settled jobs only: count, median reward, p25/p75, median
   time-to-payment (already honestly measurable — that machinery exists), last-settled
   timestamp. Raw USDC units aggregated exactly; display conversion at the edge.

2. **Publication** (public site): a "Clearing prices" section on the public record
   page, same reading style as the existing participant stats. Every figure carries
   its sample size; **task types below a minimum sample (n < 5 settled) render as
   "insufficient volume", never as a number** — a reference rate built on three
   trades is a lie with an axis.

3. **Machine-readable mirror**: the same aggregates on a public JSON endpoint next to
   the existing discovery/transparency surfaces, so agents can price work
   mechanically (this is demand-side: an agent that can see the going rate can
   decide to come work).

## Rules

- Truth boundary hard line: settled receipts only — no listed-but-unclaimed jobs, no
  projections, no smoothing. Where volume is thin the page says thin.
- Self-posted/curated split disclosed: at today's scale most volume is
  operator-curated; the aggregate must label the curated share so nobody mistakes
  dogfood for a market (the arrivals-funnel classification rules apply — classify by
  poster, as the transparency page already does).
- Revenue boundary: platform revenue appears nowhere; these are worker-side clearing
  prices.
- No new figures on marketing pages without the allow-list check (the two silent
  allow-lists gotcha).

## Acceptance (Claude gates)

- Every published number reproducible from public chain receipts by an outside
  reader (spot-check three task types against ReservationSettled history).
- Sub-sample task types show "insufficient volume".
- Curated-vs-external share visible on the section.
- JSON mirror serves the identical aggregates (one source).

## Not in scope

Forwards, capacity reservations, or any tradeable instrument · price *setting* (we
publish, never suggest) · per-agent wage pages (privacy posture stays as is).

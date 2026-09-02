import { sql } from "ponder";

import type { PublishedOutcome } from "./xcm-upstream-source";

export function buildUpsertExternalOutcomeSql(outcome: PublishedOutcome) {
  return sql`
    INSERT INTO xcm_external_outcomes (
      request_id,
      status,
      settled_assets,
      settled_shares,
      remote_ref,
      failure_code,
      observed_at,
      source
    ) VALUES (
      ${outcome.requestId},
      ${outcome.status},
      ${outcome.settledAssets},
      ${outcome.settledShares},
      ${outcome.remoteRef},
      ${outcome.failureCode},
      ${outcome.observedAt},
      ${outcome.source}
    )
    ON CONFLICT (request_id) DO UPDATE SET
      status = EXCLUDED.status,
      settled_assets = EXCLUDED.settled_assets,
      settled_shares = EXCLUDED.settled_shares,
      remote_ref = EXCLUDED.remote_ref,
      failure_code = EXCLUDED.failure_code,
      observed_at = EXCLUDED.observed_at,
      source = EXCLUDED.source,
      ingested_at = now()
    WHERE xcm_external_outcomes.observed_at <= EXCLUDED.observed_at
  `;
}

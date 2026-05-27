import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

test("backup scripts do not let docker compose exec drain caller stdin", async () => {
  const postgres = await readFile(join(REPO_ROOT, "scripts/ops/backup-postgres.sh"), "utf8");
  const redis = await readFile(join(REPO_ROOT, "scripts/ops/backup-redis.sh"), "utf8");

  assert.match(
    postgres,
    /exec -T postgres pg_dump -U "\$POSTGRES_USER" -d "\$POSTGRES_DB" <\/dev\/null \| gzip > "\$OUTPUT_FILE"/u
  );
  assert.match(
    redis,
    /exec -T "\$REDIS_SERVICE" redis-cli "\$\{REDIS_AUTH_ARGS\[@\]\}" "\$@" <\/dev\/null/u
  );
  assert.match(
    redis,
    /exec -T "\$REDIS_SERVICE" cat "\$SNAPSHOT_PATH" <\/dev\/null \| gzip > "\$OUTPUT_FILE"/u
  );
});

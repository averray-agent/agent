import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CHECK_SCRIPT = join(REPO_ROOT, "scripts/ops/check-hosted-stack.sh");

test("docker product-proof gate can read hosted worker-loop evidence", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /PRODUCT_PROOF_EVIDENCE_FILE="\$repo_root\/\$PRODUCT_PROOF_EVIDENCE_FILE"/u,
    "relative evidence paths should be normalized before node or docker checks"
  );
  assert.match(
    script,
    /product_proof_evidence_dir="\$\(dirname "\$PRODUCT_PROOF_EVIDENCE_FILE"\)"/u,
    "docker fallback should derive the host evidence directory"
  );
  assert.match(
    script,
    /mkdir -p "\$product_proof_evidence_dir"/u,
    "docker fallback should create the host evidence directory"
  );
  assert.match(
    script,
    /product_proof_docker_volume_args=\(-v "\$repo_root:\/workspace"\)/u,
    "docker fallback should keep mounting the repository"
  );
  assert.match(
    script,
    /product_proof_docker_volume_args\+=\(-v "\$product_proof_evidence_dir:\$product_proof_evidence_dir"\)/u,
    "docker fallback should mount the evidence directory at the same absolute path"
  );
  assert.match(
    script,
    /"\$\{product_proof_docker_volume_args\[@\]\}"/u,
    "docker fallback should pass the dynamic volume list to docker run"
  );
});

test("operator reporting gate keeps email optional and guards secrets", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /BOOTSTRAP_SELF_REPORT_EXPECTED_FROM=/u,
    "optional email smoke should support an explicit expected sender check"
  );
  assert.match(
    script,
    /BOOTSTRAP_SELF_REPORT_EXPECTED_TO=/u,
    "optional email smoke should support an explicit expected recipient check"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.providerConfigured \| type\) == "boolean"/u,
    "operator reporting instrumentation should expose optional email provider state"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.to \| type\) == "array"/u,
    "operator reporting instrumentation should expose a concrete recipient list"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.providerConfigured == false or/u,
    "base operator reporting smoke should not require a paid or verified email provider"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.recipientCount == \(\.bootstrapSelfReport\.to \| length\)/u,
    "recipientCount should agree with the visible recipient list when email is configured"
  );
  assert.ok(
    script.includes('test("Bearer\\\\s+[^\\\\s,}\\\\]]+|re_[A-Za-z0-9_-]{12,}"; "i")'),
    "bootstrap status should be scanned for API-key-shaped tokens"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.lastAttemptedAt \| type\) == "string"/u,
    "sent gate should require lastAttemptedAt"
  );
  assert.match(
    script,
    /\.bootstrapSelfReport\.lastSuccessfulAt \| type\) == "string"/u,
    "sent gate should require lastSuccessfulAt"
  );
  assert.match(
    script,
    /BOOTSTRAP_SELF_REPORT_MAX_AGE_SEC/u,
    "optional sent-email gate should bound the freshness of lastSuccessfulAt"
  );
});

test("scoped service-token proof gate is opt-in, admin-gated, and supports evidence files", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /CHECK_SERVICE_TOKEN_PROOF=\$\{CHECK_SERVICE_TOKEN_PROOF:-0\}/u,
    "service-token proof should be opt-in"
  );
  assert.match(
    script,
    /CHECK_SERVICE_TOKEN_PROOF=1 requires ADMIN_JWT/u,
    "service-token proof should fail closed without an admin token"
  );
  assert.match(
    script,
    /SERVICE_TOKEN_PROOF_EVIDENCE_FILE="\$repo_root\/\$SERVICE_TOKEN_PROOF_EVIDENCE_FILE"/u,
    "relative service-token evidence paths should be normalized before node or docker checks"
  );
  assert.match(
    script,
    /service_token_proof_evidence_dir="\$\(dirname "\$SERVICE_TOKEN_PROOF_EVIDENCE_FILE"\)"/u,
    "docker fallback should derive the service-token evidence host directory"
  );
  assert.match(
    script,
    /mkdir -p "\$service_token_proof_evidence_dir"/u,
    "docker fallback should create the service-token evidence host directory"
  );
  assert.match(
    script,
    /node "\$script_dir\/check-service-token-proof\.mjs"/u,
    "node path should invoke the service-token proof checker"
  );
  assert.match(
    script,
    /node scripts\/ops\/check-service-token-proof\.mjs/u,
    "docker fallback should invoke the service-token proof checker"
  );
  assert.match(
    script,
    /SERVICE_TOKEN_PROOF_CAPABILITIES="\$SERVICE_TOKEN_PROOF_CAPABILITIES"/u,
    "service-token proof should pass capability overrides through"
  );
  assert.match(
    script,
    /service_token_proof_docker_volume_args\+=\(-v "\$service_token_proof_evidence_dir:\$service_token_proof_evidence_dir"\)/u,
    "docker fallback should mount service-token evidence at the same absolute path"
  );
});

test("metrics auth gate is opt-in and verifies both denied and allowed scrapes", async () => {
  const script = await readFile(CHECK_SCRIPT, "utf8");

  assert.match(
    script,
    /CHECK_METRICS_AUTH=\$\{CHECK_METRICS_AUTH:-0\}/u,
    "metrics auth proof should be opt-in"
  );
  assert.match(
    script,
    /CHECK_METRICS_AUTH=1 requires METRICS_BEARER_TOKEN/u,
    "metrics auth proof should fail closed without the scraper token"
  );
  assert.match(
    script,
    /Expected unauthenticated \/metrics to return 401/u,
    "metrics auth proof should require no-bearer requests to be denied"
  );
  assert.match(
    script,
    /authorization: Bearer \$METRICS_BEARER_TOKEN/u,
    "metrics auth proof should send the scraper bearer token"
  );
  assert.match(
    script,
    /Expected bearer-authenticated \/metrics to return 200/u,
    "metrics auth proof should require bearer-authenticated scrapes to work"
  );
});

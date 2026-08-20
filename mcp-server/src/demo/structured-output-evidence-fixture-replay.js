import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { StructuredOutputEvidenceRunner } from "../services/structured-output-evidence-runner.js";
import { VerificationProfileRegistry } from "../services/verification-profile-registry.js";

const FIXTURE_URL = new URL(
  "../services/__fixtures__/structured-output-evidence-v1-known-good.json",
  import.meta.url
);

export async function replayStructuredOutputEvidenceFixture() {
  const fixture = JSON.parse(await readFile(FIXTURE_URL, "utf8"));
  const contentByUrl = fixtureContentByUrl(fixture);
  const runner = new StructuredOutputEvidenceRunner({
    // The proxy guard image is read-only and intentionally has no /tmp mount.
    // Docker's private /dev/shm remains writable, memory-backed, and scoped to
    // this one compose process, so the image proof can exercise the real
    // materialize-and-rehash path without changing the production topology.
    makeTemporaryDirectory: () => mkdtemp(join("/dev/shm", "averray-structured-verify-")),
    removeTemporaryDirectory: (path) => rm(path, { recursive: true, force: true }),
    materializeArtifactImpl: async (artifact, destination) => {
      const content = contentByUrl.get(artifact.locator.url);
      if (content === undefined) throw new Error(`Fixture omitted ${artifact.locator.url}.`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
      return { path: destination };
    }
  });
  const profile = new VerificationProfileRegistry().get("structured-output-evidence-v1", 1);
  const execution = await runner.run({
    profile,
    runId: "structured-output-evidence-compose-replay",
    target: fixture.request.target,
    inputs: fixture.request.inputs
  });
  return { fixture, execution };
}

function fixtureContentByUrl(fixture) {
  return new Map([
    [fixture.request.target.output.locator.url, fixture.artifacts.output],
    [fixture.request.target.schema.locator.url, fixture.artifacts.schema],
    ...fixture.request.target.sources.map((source, index) => [
      source.locator.url,
      fixture.artifacts.sources[index]
    ])
  ]);
}

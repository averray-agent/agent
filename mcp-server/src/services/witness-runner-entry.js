import { createStateStore } from "../core/state-store.js";
import { loadWitnessRunnerConfig, WitnessRunnerService } from "./witness-runner-service.js";

const config = loadWitnessRunnerConfig(process.env);
const stateStore = createStateStore(process.env);
const service = new WitnessRunnerService({ stateStore, ...config, logger: console });

const availability = await service.inspectAvailability();
if (availability.status !== "available") {
  console.warn("witness_runner.unavailable", {
    reasonCode: availability.reasonCode,
    reason: availability.reason
  });
}

service.start();
console.info("witness_runner.started", {
  intervalMs: config.intervalMs,
  claimLeaseSeconds: config.claimLeaseSeconds,
  dockerHost: process.env.DOCKER_HOST,
  stateStore: "redis",
  listener: "none"
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    service.stop();
    process.exit(0);
  });
}

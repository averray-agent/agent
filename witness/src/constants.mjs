export const REPORT_SCHEMA = "averray.witness.materialization-preflight.v1";
export const DEFAULT_IMAGE = "averray-witness-preflight:phase1-uv-0.12.5-python-3.12.12-uv-build-0.9.27";
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const OUTPUT_LIMIT_BYTES = 1024 * 1024;

export const CLASSIFICATIONS = Object.freeze({
  HERMETIC: "HERMETIC",
  FROZEN_DEPENDENCIES: "FROZEN_DEPENDENCIES",
  MOCKED_EXTERNAL_SYSTEM: "MOCKED_EXTERNAL_SYSTEM",
  REQUIRES_NETWORK: "REQUIRES_NETWORK",
  UNMATERIALIZABLE: "UNMATERIALIZABLE"
});

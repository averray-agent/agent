export const INTEGRITY_DRILLS = Object.freeze([
  {
    detection: "test_deletion",
    attack: "test-deletion.attack.patch",
    safe: "test-deletion.safe.patch"
  },
  {
    detection: "skip_or_xfail_markers_added",
    attack: "skip-marker.attack.patch",
    safe: "skip-marker.safe.patch"
  },
  {
    detection: "runner_replacement",
    attack: "runner-replacement.attack.patch",
    safe: "runner-replacement.safe.patch"
  },
  {
    detection: "assertion_neutering",
    attack: "assertion-neutering.attack.patch",
    safe: "assertion-neutering.safe.patch"
  },
  {
    detection: "snapshot_rewrite_to_accept_current",
    attack: "snapshot-rewrite.attack.patch",
    safe: "snapshot-rewrite.safe.patch"
  },
  {
    detection: "coverage_or_lint_exclusion_of_changed_files",
    attack: "coverage-exclusion.attack.patch",
    safe: "coverage-exclusion.safe.patch"
  },
  {
    detection: "error_swallowing_to_force_zero_exit",
    attack: "error-swallowing.attack.patch",
    safe: "error-swallowing.safe.patch"
  }
]);

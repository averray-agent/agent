export async function importCeremonyModule({ label, candidates, importer = (specifier) => import(specifier) }) {
  const attempted = [];
  const failures = [];
  for (const candidate of candidates ?? []) {
    const specifier = candidate instanceof URL ? candidate.href : String(candidate ?? "");
    if (!specifier) continue;
    attempted.push(specifier);
    try {
      return await importer(specifier);
    } catch (error) {
      failures.push(`${specifier}: ${error?.message ?? error}`);
    }
  }
  const error = new Error(
    `ceremony_module_resolution_failed: ${label} could not be loaded. `
    + `Attempted paths: ${attempted.join(", ") || "none"}. `
    + `Failures: ${failures.join(" | ") || "none"}.`,
  );
  error.code = "ceremony_module_resolution_failed";
  throw error;
}

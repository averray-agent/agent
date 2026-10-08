const GRADER_ONLY_FIELDS = new Set(["expectedOutputs", "rubric", "answerKey", "benchmarkInputs"]);

// Copy at the worker-facing response boundary, never mutate the definition or
// claim snapshot used for verification. Arrays/nested configs are covered too.
export function redactPublicGraderFields(value) {
  if (Array.isArray(value)) return value.map(redactPublicGraderFields);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !GRADER_ONLY_FIELDS.has(key))
    .map(([key, entry]) => [key, redactPublicGraderFields(entry)]));
}

export function substantiveVerifierTerms(...values) {
  return [...new Set(
    values
      .flat()
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
  )];
}

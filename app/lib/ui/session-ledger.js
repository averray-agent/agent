/** Derive session filter taxonomies only from rows the feed actually emitted. */
export function buildSessionFilterOptions(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  return {
    states: unique(safeRows.map((row) => text(row?.state))),
    assets: unique(safeRows.map((row) => text(row?.escrow?.asset))),
    verifiers: unique(safeRows.map((row) => text(row?.verifierMode))),
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

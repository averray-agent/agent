export function normalizeAdvancingNextCursor(
  rawNextCursor: unknown,
  itemCount: number,
  sourceLabel = "XCM feed"
) {
  const nextCursor = typeof rawNextCursor === "string" && rawNextCursor.trim()
    ? rawNextCursor.trim()
    : undefined;
  if (itemCount > 0 && !nextCursor) {
    throw new Error(`${sourceLabel} returned items without nextCursor; non-empty XCM batches must advance the cursor.`);
  }
  return nextCursor;
}

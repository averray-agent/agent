// Parse a compact duration string into milliseconds.
// Supported units: h (hours), m (minutes), s (seconds).
// Examples: "90s" -> 90000, "1h30m" -> 5400000
const UNIT_MS = { h: 3_600_000, m: 60_000, s: 1_000 };

export function parseDuration(input) {
  const matches = input.matchAll(/(\d+)([hms])/g);
  let total = 0;
  for (const [, amount, unit] of matches) {
    total += Number(amount) * UNIT_MS[unit];
  }
  return total;
}

export function formatDuration(ms) {
  const hours = Math.floor(ms / UNIT_MS.h);
  const minutes = Math.floor((ms % UNIT_MS.h) / UNIT_MS.m);
  const seconds = Math.floor((ms % UNIT_MS.m) / UNIT_MS.s);
  return [
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
    seconds ? `${seconds}s` : "",
  ].join("");
}

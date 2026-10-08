/** Public JSON lives on the API, not the app's static page router. */
export function publicReceiptUrl(path, base = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_API_BASE_URL : undefined) {
  const origin = base || "https://api.averray.com";
  return origin.replace(/\/+$/u, "") + path;
}

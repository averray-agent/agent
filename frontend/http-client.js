import { getAuthHeader, requestReauth } from "./auth.js";

async function requestJson(path, init = {}, { retryOn401 = true } = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  // Inject the Bearer token if the caller has authenticated. Requests for
  // public routes (health, onboarding, jobs catalog, login endpoints) simply
  // proceed without one.
  const authHeader = getAuthHeader();
  for (const [key, value] of Object.entries(authHeader)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }

  const response = await fetch(path, {
    ...init,
    headers
  });

  const text = await response.text();
  const payload = text ? safeJsonParse(text) : undefined;

  if (response.status === 401 && retryOn401) {
    // Clear the stale token and prompt the user to re-sign. If that succeeds,
    // replay the original request exactly once with the new token.
    try {
      await requestReauth(payload?.error ?? "unauthorized");
    } catch (error) {
      throw new Error(payload?.message ?? error?.message ?? "Sign in required.");
    }
    return requestJson(path, init, { retryOn401: false });
  }

  if (!response.ok) {
    throw new Error(payload?.message ?? payload?.error ?? payload?.status ?? `${path} returned ${response.status}`);
  }

  return payload;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function readJson(path) {
  return requestJson(path);
}

export function postJson(path, body = undefined) {
  return requestJson(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

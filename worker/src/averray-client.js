function requiredText(value, name) {
  const normalized = value == null ? "" : String(value).trim();
  if (!normalized) {
    throw new TypeError(`${name} is required`);
  }
  return normalized;
}

export async function fetchJobDefinition(jobId, options = {}) {
  const id = requiredText(jobId, "jobId");
  const baseUrl = requiredText(
    options.baseUrl ?? process.env.AVERRAY_API_BASE_URL,
    "AVERRAY_API_BASE_URL",
  );
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetch is unavailable");
  }

  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/jobs/definition`);
  url.searchParams.set("jobId", id);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Averray job definition request failed with HTTP ${response.status}`);
  }
  return response.json();
}

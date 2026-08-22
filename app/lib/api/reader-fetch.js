export const APP_READER_TIMEOUT_MS = 3_000;
export const APP_READER_ATTEMPTS = 2;

/**
 * Bound first-paint reads so a restricted client cannot hold an honest loading
 * state behind one lost request for eight seconds. Each attempt gets a fresh
 * controller; an explicit caller abort is final, while a local timeout may use
 * the single retry.
 */
export async function fetchAppReadWithRetry(url, init = {}, runtime = {}) {
  const fetchImpl = runtime.fetchImpl ?? globalThis.fetch;
  const AbortControllerImpl = runtime.AbortControllerImpl ?? globalThis.AbortController;
  const timeoutMs = runtime.timeoutMs ?? APP_READER_TIMEOUT_MS;
  const attempts = runtime.attempts ?? APP_READER_ATTEMPTS;
  const externalSignal = init.signal;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortControllerImpl();
    const abortFromCaller = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) {
      abortFromCaller();
    } else {
      externalSignal?.addEventListener?.("abort", abortFromCaller, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      lastError = error;
      if (externalSignal?.aborted || attempt === attempts - 1) throw error;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.("abort", abortFromCaller);
    }
  }

  throw lastError;
}

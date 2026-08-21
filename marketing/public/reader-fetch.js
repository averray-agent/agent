/** Bounded fetch shared by the public-site readers. */
(function (scope) {
  "use strict";

  var DEFAULT_TIMEOUT_MS = 8000;
  var ATTEMPTS = 2;

  async function readJsonWithRetry(url, options, runtime) {
    var tools = runtime || {};
    var fetchImpl = tools.fetch || scope.fetch;
    var Controller = tools.AbortController || scope.AbortController;
    var schedule = tools.setTimeout || scope.setTimeout;
    var cancel = tools.clearTimeout || scope.clearTimeout;
    var timeoutMs = tools.timeoutMs || DEFAULT_TIMEOUT_MS;
    var lastError;

    for (var attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      var controller = new Controller();
      var timeout = schedule(function () { controller.abort(); }, timeoutMs);
      try {
        var response = await fetchImpl(url, Object.assign({}, options, { signal: controller.signal }));
        if (!response.ok) {
          var responseError = new Error("HTTP " + response.status);
          responseError.status = response.status;
          throw responseError;
        }
        return await response.json();
      } catch (error) {
        lastError = error;
      } finally {
        cancel(timeout);
      }
    }

    throw lastError || new Error("Reader request failed");
  }

  scope.AverrayReaderFetch = Object.freeze({
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    readJsonWithRetry: readJsonWithRetry
  });
})(window);

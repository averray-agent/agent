/**
 * Write-through Map for account overlay state — Package C Phase 2.
 *
 * Phase 1 of Package C (PR #408) closed the silent-stale-cache half of
 * the P1.2 finding by inverting precedence in
 * `attachStoredTreasuryMetadata` (live wins over stored per-key). Phase
 * 2 — this module — closes the durability half: the in-memory Map that
 * `AccountMutationService` reads and writes now mirrors every update
 * out to a durable `stateStore` (Redis in production, Memory in dev),
 * so a process restart no longer loses operator-relevant overlay
 * fields.
 *
 * Design constraints:
 *
 * - `AccountMutationService` and `PlatformService` both expect the
 *   `accounts` argument to expose a Map-compatible `.get(wallet)` and
 *   `.set(wallet, account)` interface. This class preserves that
 *   contract so the consumers do not need a refactor.
 * - Writes are *fire-and-forget*: `.set()` updates the in-memory cache
 *   synchronously and then enqueues a persist against the state-store.
 *   The cache is always the freshest source of truth within a process;
 *   the state-store is the durable backup that survives restart. A
 *   crash between cache write and state-store flush loses at most the
 *   pending writes, which matches the pre-Phase-2 behavior (no
 *   durability at all).
 * - Persists for the *same wallet* are serialized through a per-wallet
 *   queue so two updates can't land out of order. Different wallets
 *   persist in parallel.
 * - `hydrate()` is called once at bootstrap before the HTTP server
 *   accepts requests. It loads every wallet's overlay from the
 *   state-store into the cache. After hydrate, `.get(wallet)` is a
 *   pure cache hit.
 * - The state-store dependency is optional. If `stateStore` is
 *   undefined or doesn't implement the overlay methods, the store
 *   degrades to a plain in-memory Map (the pre-Phase-2 behavior). This
 *   keeps unit tests that construct services without a state-store
 *   working unchanged.
 *
 * Not solved by this module (deliberate scope):
 *
 * - Multi-process consistency. Two backend processes pointing at the
 *   same Redis state-store will both hydrate from it at boot but their
 *   in-memory caches will diverge as soon as either takes writes,
 *   because neither subscribes to the other's persists. For
 *   single-process v1 deploys this is fine. Multi-process needs either
 *   cache-invalidation pub/sub or full-async reads on every `.get()`.
 * - API-level field-source labeling on operator responses. The
 *   `ACCOUNT_OVERLAY_CLASSIFICATION` constant from
 *   `account-mutation-service.js` is the source of truth and an
 *   external consumer can import it; an inline `_meta.fieldSources`
 *   blob on every account response is a future contract change.
 */

export class AccountOverlayStore {
  /**
   * @param {object} options
   * @param {object} [options.stateStore] — implements `getAccountOverlay`,
   *   `upsertAccountOverlay`, `listAccountOverlayWallets`. When
   *   undefined or missing methods, behaves as a plain Map.
   * @param {object} [options.logger] — pino-style logger; persist
   *   failures land here at `warn` level. Defaults to console.
   */
  constructor({ stateStore = undefined, logger = console } = {}) {
    this.cache = new Map();
    this.stateStore = stateStore;
    this.logger = logger;
    /** @type {Map<string, Promise<void>>} per-wallet persist serialization */
    this.persistQueues = new Map();
  }

  // ── Map-compatible API ─────────────────────────────────────────────

  get(wallet) {
    return this.cache.get(wallet);
  }

  set(wallet, account) {
    this.cache.set(wallet, account);
    this._enqueuePersist(wallet, account);
    return this;
  }

  has(wallet) {
    return this.cache.has(wallet);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Seed an entry into the cache without persisting it. Used by
   * bootstrap.js to install the dev fixture wallet ("0xagent") before
   * production data is loaded. Production deploys should not seed.
   */
  seed(wallet, account) {
    this.cache.set(wallet, account);
  }

  /**
   * Load every persisted overlay from the state-store into the
   * in-memory cache. Idempotent — safe to call multiple times. If the
   * state-store is missing or doesn't expose the overlay methods this
   * is a no-op. Existing seeded entries are preserved unless the
   * state-store has the same wallet, in which case the persisted copy
   * wins (it reflects more recent writes than the dev seed).
   */
  async hydrate() {
    if (!this.stateStore?.listAccountOverlayWallets || !this.stateStore?.getAccountOverlay) {
      return { hydrated: 0, skipped: 0, reason: "state-store unavailable" };
    }
    let hydrated = 0;
    const wallets = await this.stateStore.listAccountOverlayWallets();
    for (const wallet of wallets) {
      const overlay = await this.stateStore.getAccountOverlay(wallet);
      if (overlay) {
        this.cache.set(wallet, overlay);
        hydrated += 1;
      }
    }
    return { hydrated, skipped: wallets.length - hydrated };
  }

  /**
   * Wait for every pending persist to drain. Useful in tests so we can
   * assert the state-store reflects the latest set() before tearing
   * the store down.
   */
  async flush() {
    await Promise.all(Array.from(this.persistQueues.values()));
  }

  // ── Internal ──────────────────────────────────────────────────────

  _enqueuePersist(wallet, account) {
    if (!this.stateStore?.upsertAccountOverlay) {
      return;
    }
    const previous = this.persistQueues.get(wallet) ?? Promise.resolve();
    const next = previous.then(() =>
      this.stateStore.upsertAccountOverlay(wallet, account).catch((error) => {
        this.logger?.warn?.(
          { wallet, error: error?.message ?? String(error) },
          "account-overlay.persist_failed"
        );
      })
    );
    this.persistQueues.set(wallet, next);
    next.finally(() => {
      if (this.persistQueues.get(wallet) === next) {
        this.persistQueues.delete(wallet);
      }
    });
  }
}

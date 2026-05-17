/**
 * PolicyService — Package G (P2.5b) close.
 *
 * Built-in policies + operator-proposed policies previously lived
 * inline in `mcp-server/src/protocols/http/server.js` as a route-local
 * `BUILTIN_POLICIES` array plus a process-local `POLICY_PROPOSALS`
 * Map. Proposals disappeared on every restart — fine while only one
 * operator was proposing, but the audit board flags this as the
 * blocking gap before external operators or posters arrive.
 *
 * This service mirrors the write-through pattern Package C established
 * for `AccountOverlayStore`:
 *
 *   - Built-in policies are read-only seed data loaded from
 *     `builtin-policies.js` at construction time.
 *   - Proposals live in an in-memory cache for fast reads and a
 *     state-store backing for durability.
 *   - Every `propose()` updates the cache synchronously and enqueues
 *     a per-tag persist against the state-store.
 *   - `hydrate()` runs once at bootstrap and reloads persisted
 *     proposals into the cache before the HTTP server accepts
 *     requests.
 *
 * Lookups (`listAll`, `findByTagOrId`) combine seed + cache; the seed
 * set appears first so the route response matches the legacy
 * `[...BUILTIN_POLICIES, ...POLICY_PROPOSALS.values()]` ordering.
 *
 * Multi-process consistency notes are the same as
 * `AccountOverlayStore`: two backend replicas pointing at the same
 * Redis state-store both hydrate at boot but their caches diverge as
 * soon as either takes writes. Single-process v1 deploys are
 * unaffected.
 */

export class PolicyService {
  /**
   * @param {object} options
   * @param {object} [options.stateStore] — implements
   *   `getPolicyProposal`, `upsertPolicyProposal`,
   *   `listPolicyProposalTags`. Optional; when missing, the service
   *   degrades to an in-memory store (the pre-Package-G behavior).
   * @param {object[]} [options.seedPolicies] — built-in policy array,
   *   defaults to `[]`. Pass `BUILTIN_POLICIES` from `builtin-policies.js`
   *   in production.
   * @param {object} [options.logger] — pino-style logger; persist
   *   failures land at `warn` level. Defaults to console.
   */
  constructor({ stateStore = undefined, seedPolicies = [], logger = console } = {}) {
    this.stateStore = stateStore;
    this.seedPolicies = Array.isArray(seedPolicies) ? seedPolicies : [];
    this.logger = logger;
    /** @type {Map<string, object>} tag → proposal (operator-created) */
    this.cache = new Map();
    /** @type {Map<string, Promise<void>>} per-tag persist serialization */
    this.persistQueues = new Map();
  }

  /**
   * Return every policy known to the service: built-in seeds first,
   * then proposals. Mirrors the legacy
   * `[...BUILTIN_POLICIES, ...POLICY_PROPOSALS.values()]` order.
   */
  listAll() {
    return [...this.seedPolicies, ...this.cache.values()];
  }

  /**
   * Find a policy by `tag` (e.g. `claim/deps-sec-only@v4`) or `id`
   * (e.g. `p-claim-deps-sec-only`). Matches the legacy `findPolicy`.
   */
  findByTagOrId(value) {
    if (!value) return undefined;
    return this.listAll().find(
      (policy) => policy.tag === value || policy.id === value
    );
  }

  /**
   * Return only the operator-proposed policies (no built-ins).
   * Useful for admin status surfaces that want to render the
   * pending/awaiting-approval set.
   */
  listProposals() {
    return Array.from(this.cache.values());
  }

  /**
   * Add or replace a proposal. The cache is updated synchronously;
   * the durable persist is enqueued per-tag. Returns the proposal so
   * route handlers can keep their existing return-the-proposal shape.
   */
  propose(proposal) {
    if (!proposal || typeof proposal !== "object") {
      throw new Error("PolicyService.propose requires a proposal object");
    }
    const tag = proposal.tag;
    if (!tag) {
      throw new Error("PolicyService.propose requires proposal.tag");
    }
    this.cache.set(tag, proposal);
    this._enqueuePersist(tag, proposal);
    return proposal;
  }

  /**
   * Load every persisted proposal from the state-store into the
   * in-memory cache. Idempotent. No-op when the state-store is
   * missing or doesn't expose the policy-proposal methods.
   */
  async hydrate() {
    if (
      !this.stateStore?.listPolicyProposalTags
      || !this.stateStore?.getPolicyProposal
    ) {
      return { hydrated: 0, skipped: 0, reason: "state-store unavailable" };
    }
    let hydrated = 0;
    const tags = await this.stateStore.listPolicyProposalTags();
    for (const tag of tags) {
      const proposal = await this.stateStore.getPolicyProposal(tag);
      if (proposal) {
        this.cache.set(tag, proposal);
        hydrated += 1;
      }
    }
    return { hydrated, skipped: tags.length - hydrated };
  }

  /**
   * Wait for every pending persist to drain. Used by tests so the
   * state-store contents can be asserted right after a `.propose()`.
   */
  async flush() {
    await Promise.all(Array.from(this.persistQueues.values()));
  }

  _enqueuePersist(tag, proposal) {
    if (!this.stateStore?.upsertPolicyProposal) {
      return;
    }
    const previous = this.persistQueues.get(tag) ?? Promise.resolve();
    const next = previous.then(() =>
      this.stateStore.upsertPolicyProposal(tag, proposal).catch((error) => {
        this.logger?.warn?.(
          { tag, error: error?.message ?? String(error) },
          "policy.persist_failed"
        );
      })
    );
    this.persistQueues.set(tag, next);
  }
}

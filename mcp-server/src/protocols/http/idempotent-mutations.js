import { hashCanonicalContent } from "../../core/canonical-content.js";
import { ConflictError } from "../../core/errors.js";

export function createIdempotentMutationHelpers({ stateStore, respond, now = () => new Date() }) {
  const inFlightIdempotentMutations = new Map();

  function parseIdempotencyKey(payload = {}) {
    return typeof payload?.idempotencyKey === "string" && payload.idempotencyKey.trim()
      ? payload.idempotencyKey.trim()
      : undefined;
  }

  function stripIdempotencyKey(payload = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return payload;
    }
    const { idempotencyKey, ...rest } = payload;
    return rest;
  }

  function buildMutationRequestHash({ route, wallet, payload }) {
    return hashCanonicalContent({
      route,
      wallet,
      payload: stripIdempotencyKey(payload)
    });
  }

  function buildIdempotentMutationContext({ route, auth, payload, normalizedPayload, bucket }) {
    const idempotencyKey = parseIdempotencyKey(payload);
    return {
      bucket,
      key: idempotencyKey ? `${auth.wallet}:${idempotencyKey}` : undefined,
      requestHash: buildMutationRequestHash({
        route,
        wallet: auth.wallet,
        payload: normalizedPayload ?? payload
      })
    };
  }

  function buildScopedIdempotentMutationContext({ route, auth, scope, payload, normalizedPayload, bucket }) {
    const idempotencyKey = parseIdempotencyKey(payload);
    return {
      bucket,
      key: idempotencyKey ? `${auth.wallet}:${scope}:${idempotencyKey}` : undefined,
      requestHash: buildMutationRequestHash({
        route,
        wallet: auth.wallet,
        payload: normalizedPayload ?? payload
      })
    };
  }

  function isMutationReceiptEnvelope(receipt) {
    return Boolean(
      receipt
      && typeof receipt === "object"
      && typeof receipt.requestHash === "string"
      && Object.prototype.hasOwnProperty.call(receipt, "response")
    );
  }

  async function getIdempotentMutationReplay({ bucket, key, requestHash }) {
    if (!key) {
      return undefined;
    }
    const existing = await stateStore.getMutationReceipt?.(bucket, key);
    if (!existing) {
      return undefined;
    }
    if (!isMutationReceiptEnvelope(existing)) {
      return { statusCode: 200, body: existing };
    }
    if (existing.requestHash !== requestHash) {
      throw new ConflictError(
        "Idempotency key was already used with a different request payload.",
        "idempotency_key_payload_mismatch",
        {
          bucket,
          originalRequestHash: existing.requestHash,
          requestHash
        }
      );
    }
    return { statusCode: 200, body: existing.response };
  }

  async function storeIdempotentMutationReceipt({ bucket, key, requestHash, response, statusCode }) {
    if (!key) {
      return response;
    }
    await stateStore.upsertMutationReceipt?.(bucket, key, {
      requestHash,
      statusCode,
      response,
      createdAt: now().toISOString()
    });
    return response;
  }

  async function respondWithMutationReceipt(response, context, statusCode, body) {
    await storeIdempotentMutationReceipt({
      ...context,
      response: body,
      statusCode
    });
    return respond(response, statusCode, body);
  }

  async function runIdempotentMutation(response, context, statusCode, operation) {
    const replay = await getIdempotentMutationReplay(context);
    if (replay) {
      return respond(response, replay.statusCode, replay.body);
    }

    const inFlightKey = context.key ? `${context.bucket}:${context.key}` : undefined;
    if (inFlightKey) {
      const inFlight = inFlightIdempotentMutations.get(inFlightKey);
      if (inFlight) {
        if (inFlight.requestHash !== context.requestHash) {
          throw new ConflictError(
            "Idempotency key was already used with a different request payload.",
            "idempotency_key_payload_mismatch",
            {
              bucket: context.bucket,
              originalRequestHash: inFlight.requestHash,
              requestHash: context.requestHash
            }
          );
        }
        throw new ConflictError(
          "Idempotent mutation is already in flight. Retry with the same payload after the first request completes.",
          "idempotency_key_in_flight",
          {
            bucket: context.bucket,
            requestHash: context.requestHash
          }
        );
      }
      inFlightIdempotentMutations.set(inFlightKey, {
        requestHash: context.requestHash,
        startedAt: now().toISOString()
      });
    }

    try {
      const body = await operation();
      return respondWithMutationReceipt(response, context, statusCode, body);
    } finally {
      if (inFlightKey) {
        inFlightIdempotentMutations.delete(inFlightKey);
      }
    }
  }

  return {
    buildIdempotentMutationContext,
    buildMutationRequestHash,
    buildScopedIdempotentMutationContext,
    getIdempotentMutationReplay,
    parseIdempotencyKey,
    respondWithMutationReceipt,
    runIdempotentMutation,
    storeIdempotentMutationReceipt,
    stripIdempotencyKey
  };
}

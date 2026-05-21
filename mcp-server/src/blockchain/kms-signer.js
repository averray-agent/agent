/**
 * AWS KMS-backed ethers signer adapter.
 *
 * Phase 3 (per docs/SECRETS_MIGRATION.md §"Phase 3 — AWS KMS for the
 * backend signer"). Drop-in replacement for `new ethers.Wallet(...)` —
 * implements the same ethers `AbstractSigner` interface, but the
 * private key material never leaves AWS KMS. The signer calls
 * `kms:Sign` in DIGEST mode for each operation.
 *
 * Wiring (see config.js + gateway.js): when SIGNER_BACKEND=kms, the
 * gateway constructs a KmsSigner instead of a Wallet. Everything
 * downstream (ethers Contracts, sendTransaction, etc.) sees the same
 * signer interface.
 *
 * IAM permissions required on the role this signer assumes:
 *   - kms:GetPublicKey (called once, cached for the lifetime of the
 *     KmsSigner; needed to derive our own EVM address)
 *   - kms:Sign with kms:SigningAlgorithm=ECDSA_SHA_256 and
 *     kms:MessageType=DIGEST (enforced as a condition key, see
 *     deploy/iam-policies/averray-signer-prod-role.json)
 *
 * Signature flow:
 *   1. Compute the digest the way ethers does (EIP-191 for signMessage,
 *      EIP-712 for signTypedData, RLP unsignedHash for signTransaction).
 *   2. Call kms:Sign with MessageType=DIGEST so KMS treats our input
 *      as the already-hashed digest (not re-hashing it).
 *   3. Parse the DER-encoded ECDSA-Sig-Value response → raw (r, s).
 *   4. Normalize s to the low half of the group order (EIP-2).
 *   5. Determine the recovery byte (0 or 1) by attempting recovery
 *      against each candidate and matching the one that recovers our
 *      cached EVM address.
 *   6. Return the signature in the form ethers expects.
 *
 * Cost of a signature: one kms:Sign API call (~3ms typical, ~$0.03 per
 * 10k calls in eu-central-1). Public key fetch is one extra
 * kms:GetPublicKey call per KmsSigner instance lifetime.
 */

import {
  AbstractSigner,
  Signature,
  Transaction,
  TypedDataEncoder,
  getBytes,
  hashMessage,
  recoverAddress,
  toUtf8Bytes,
} from "ethers";

import {
  addressFromUncompressedPoint,
  normalizeSignatureS,
  parseDerEcdsaSignature,
  parseSecp256k1Spki,
} from "./spki.js";

export class KmsSigner extends AbstractSigner {
  #kmsClient;
  #region;
  #credentialsProvider;
  #keyId;
  #cachedAddress = null;
  // Promise-coalescing: if two callers race for getAddress() before
  // the first GetPublicKey response lands, share the in-flight promise
  // rather than issuing a second KMS call.
  #addressInflight = null;

  /**
   * @param {object} options
   * @param {object} [options.kmsClient]  An existing AWS SDK v3 KMSClient
   *                                      (preferred for tests with mocks).
   * @param {string} [options.region]     AWS region; constructs a KMSClient
   *                                      lazily on first use when kmsClient
   *                                      is not provided. Local-backend
   *                                      deploys never hit the lazy
   *                                      construction path and don't pay
   *                                      the import cost.
   * @param {string} options.keyId        KMS key id, ARN, or alias.
   * @param {object} [options.provider]   ethers Provider; required for
   *                                      sendTransaction, optional for
   *                                      pure signing.
   * @param {import("@aws-sdk/types").AwsCredentialIdentityProvider} [options.credentialsProvider]
   *   Optional AWS SDK credentials provider passed to the lazy KMSClient.
   *   Wired by Phase 5a — see `mcp-server/src/services/aws-credentials.js`.
   *   When null/undefined, the lazy KMSClient gets no explicit credentials
   *   and falls through to the SDK's default credential chain (env vars,
   *   shared config, etc.), preserving pre-5a behavior.
   */
  constructor({ kmsClient, region, keyId, provider, credentialsProvider }) {
    super(provider ?? null);
    if (!keyId || typeof keyId !== "string") {
      throw new Error("KmsSigner: keyId is required (KMS key id, ARN, or alias)");
    }
    if (!kmsClient && !region) {
      throw new Error("KmsSigner: either kmsClient or region must be provided");
    }
    this.#kmsClient = kmsClient ?? null;
    this.#region = region ?? null;
    this.#credentialsProvider = credentialsProvider ?? null;
    this.#keyId = keyId;
  }

  async #getClient() {
    if (this.#kmsClient) return this.#kmsClient;
    // Lazy-import + lazy-construct KMSClient on first signing call.
    // Cached for the lifetime of the KmsSigner.
    const { KMSClient } = await import("@aws-sdk/client-kms");
    // Phase 5a: pass the optional credentialsProvider through. When
    // null (Roles Anywhere disabled), behavior matches pre-5a — the
    // SDK uses its default credential chain.
    const clientOpts = { region: this.#region };
    if (this.#credentialsProvider) {
      clientOpts.credentials = this.#credentialsProvider;
    }
    this.#kmsClient = new KMSClient(clientOpts);
    return this.#kmsClient;
  }

  /**
   * Return the EVM address derived from the KMS public key. Cached
   * after the first call.
   */
  async getAddress() {
    if (this.#cachedAddress) return this.#cachedAddress;
    if (this.#addressInflight) return this.#addressInflight;

    // Lazy-import the AWS SDK command classes so this module doesn't
    // pull in `@aws-sdk/client-kms` at import time for code paths
    // that never instantiate a KmsSigner (SIGNER_BACKEND=local).
    this.#addressInflight = (async () => {
      const { GetPublicKeyCommand } = await import("@aws-sdk/client-kms");
      const client = await this.#getClient();
      const { PublicKey } = await client.send(
        new GetPublicKeyCommand({ KeyId: this.#keyId }),
      );
      if (!PublicKey) {
        throw new Error(`KMS GetPublicKey for ${this.#keyId} returned empty PublicKey`);
      }
      const point = parseSecp256k1Spki(new Uint8Array(PublicKey));
      this.#cachedAddress = addressFromUncompressedPoint(point);
      return this.#cachedAddress;
    })();

    try {
      return await this.#addressInflight;
    } finally {
      this.#addressInflight = null;
    }
  }

  /**
   * Return a new KmsSigner bound to the given provider. Required for
   * compatibility with ethers Contract — Contracts may rebind their
   * runner to a different provider during fork-aware ops.
   */
  connect(provider) {
    return new KmsSigner({
      kmsClient: this.#kmsClient ?? undefined,
      region: this.#region ?? undefined,
      keyId: this.#keyId,
      provider,
      credentialsProvider: this.#credentialsProvider ?? undefined,
    });
  }

  /**
   * Sign an arbitrary message using EIP-191 prefixing. ethers does the
   * `\x19Ethereum Signed Message:\n<len><msg>` framing + keccak256;
   * we send the resulting digest to KMS.
   */
  async signMessage(message) {
    const messageBytes = typeof message === "string"
      ? toUtf8Bytes(message)
      : message;
    const digest = hashMessage(messageBytes);
    const sig = await this.#signDigest(getBytes(digest));
    return sig.serialized;
  }

  /**
   * Sign typed structured data per EIP-712.
   */
  async signTypedData(domain, types, value) {
    // `TypedDataEncoder.resolveNames` is a noop for our use case but
    // would walk the types and dereference ENS names — leave it to
    // ethers' own ResolvedName mechanism if a caller passes ENS.
    const resolvedDomain = { ...domain };
    const populated = await TypedDataEncoder.resolveNames(
      resolvedDomain,
      types,
      value,
      // ResolveName function; we don't support ENS in KmsSigner.
      (name) => {
        throw new Error(`KmsSigner.signTypedData: ENS name resolution not supported (got "${name}")`);
      },
    );
    const digest = TypedDataEncoder.hash(populated.domain, types, populated.value);
    const sig = await this.#signDigest(getBytes(digest));
    return sig.serialized;
  }

  /**
   * Sign a populated transaction object. Returns the RLP-serialized
   * signed transaction (an `0x`-prefixed hex string) ready to broadcast.
   */
  async signTransaction(tx) {
    // `tx` may arrive as either:
    //   (a) a TransactionLike POJO (direct callers, our own tests), or
    //   (b) a Transaction class instance (the AbstractSigner.sendTransaction
    //       path used by ethers Contracts — pop is wrapped via
    //       `Transaction.from(pop)` before being passed here).
    // CRITICAL: `{ ...tx }` returns `{}` for (b) because Transaction
    // exposes its fields via getters, not as enumerable own properties.
    // Use `Transaction.from(tx)` which copies fields correctly in both
    // cases; this normalizes the input before we read `from` or sign.
    //
    // Subtlety: ethers' `Transaction.from()` rejects any input (POJO or
    // instance) whose `.from` is set, with "unsigned transaction cannot
    // define '.from'". Read `tx.from` (works for both shapes — POJOs
    // have it as an own property, instances expose it via the same-named
    // getter) BEFORE coercing, then pass a sanitized POJO without
    // `from`. For Transaction instances we can't mutate the input
    // safely; for POJOs we avoid mutating the caller's object too.
    const callerFrom = tx?.from ?? null;
    let coercionInput = tx;
    if (callerFrom != null) {
      const ourAddress = await this.getAddress();
      if (String(callerFrom).toLowerCase() !== ourAddress.toLowerCase()) {
        // Confirm the populated `from` matches our address — if it
        // doesn't, the caller is using us for a tx that wouldn't recover
        // back to us. Catch the misuse here rather than letting the
        // chain reject after a wasted gas estimation.
        throw new Error(
          `KmsSigner.signTransaction: tx.from (${callerFrom}) does not match this signer's address (${ourAddress})`,
        );
      }
      // Rebuild a plain TransactionLike POJO without `from` so
      // Transaction.from() doesn't reject. Use the instance's getters
      // (or the POJO's own properties) to copy each field explicitly.
      coercionInput = {
        type: tx.type,
        chainId: tx.chainId,
        nonce: tx.nonce,
        gasLimit: tx.gasLimit,
        gasPrice: tx.gasPrice,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
        to: tx.to,
        value: tx.value,
        data: tx.data,
        accessList: tx.accessList,
      };
    }
    const unsignedTx = Transaction.from(coercionInput);
    const digest = unsignedTx.unsignedHash;
    const sig = await this.#signDigest(getBytes(digest));
    unsignedTx.signature = sig;
    return unsignedTx.serialized;
  }

  /**
   * Internal: sign a digest via KMS, parse the DER signature, normalize
   * s, and compute the recovery byte by matching against our cached
   * address. Returns an ethers `Signature` value the caller can
   * `.serialized` or assign to `tx.signature`.
   *
   * @param {Uint8Array} digestBytes  32-byte digest to sign
   * @returns {Promise<import("ethers").Signature>}
   */
  async #signDigest(digestBytes) {
    if (!(digestBytes instanceof Uint8Array) || digestBytes.length !== 32) {
      throw new Error("KmsSigner.#signDigest: expected 32-byte Uint8Array digest");
    }

    const { SignCommand } = await import("@aws-sdk/client-kms");
    const client = await this.#getClient();
    const { Signature: derSig } = await client.send(
      new SignCommand({
        KeyId: this.#keyId,
        Message: digestBytes,
        // CRITICAL: DIGEST tells KMS our Message is already a digest;
        // ECDSA_SHA_256 specifies the signing algorithm. Both are
        // enforced as condition keys in the IAM policy
        // (deploy/iam-policies/averray-signer-prod-role.json) so even
        // a compromised role credential can't ask KMS to sign a raw
        // message under a different algorithm.
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      }),
    );
    if (!derSig) {
      throw new Error("KMS Sign returned empty Signature");
    }

    const { r, s: rawS } = parseDerEcdsaSignature(new Uint8Array(derSig));
    const { s: normalizedS, flipped } = normalizeSignatureS(rawS);

    // ECDSA signatures have 2 candidate recovery bytes (yParity). KMS
    // doesn't return it; we determine it by trying each and matching
    // against our known address. If we flipped s for EIP-2, yParity
    // also flips.
    const ourAddress = await this.getAddress();
    const rHex = "0x" + Buffer.from(r).toString("hex");
    const sHex = "0x" + Buffer.from(normalizedS).toString("hex");

    for (let yParity = 0; yParity < 2; yParity++) {
      const candidate = Signature.from({ r: rHex, s: sHex, yParity });
      const recovered = recoverAddress(digestBytes, candidate);
      if (recovered.toLowerCase() === ourAddress.toLowerCase()) {
        return candidate;
      }
    }

    // If we get here something is structurally broken: either the
    // signed digest doesn't match what we asked for, or our cached
    // address doesn't match the key KMS just signed with.
    throw new Error(
      `KmsSigner: could not recover signer address from KMS signature` +
        (flipped ? " (s was normalized to low form)" : "") +
        ". Possible causes: wrong KMS key id, key rotated underneath us,",
    );
  }
}

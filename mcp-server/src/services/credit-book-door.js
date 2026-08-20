import {
  Contract,
  getAddress,
  verifyTypedData
} from "ethers";

import { AGENT_ACCOUNT_ABI, CREDIT_BOOK_ABI, ZERO_BYTES32 } from "../blockchain/abis.js";
import { buildSiweMessage, verifySiweMessage } from "../auth/siwe.js";
import { canonicalizeContent, hashCanonicalContent } from "../core/canonical-content.js";
import { ConfigError, ConflictError, NotFoundError, ValidationError } from "../core/errors.js";
import { EXTERNAL_FUNDING_RAILS } from "../core/external-posting-service.js";

export const CREDIT_DEDUCTION_DISCLOSURE =
  "deduction-first — up to half of each payout services your loan until cleared.";
export const CREDIT_PLATFORM_SWEEP_DISCLOSURE =
  "the platform submits your pre-authorized repayments";

const CASH = 0;
const POSTING = 1;
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

function amount(raw) {
  return { raw: BigInt(raw).toString(), decimals: 6 };
}

function exactPositiveRaw(value, field) {
  const raw = String(value ?? "").trim();
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new ValidationError(`${field} must be a positive exact base-unit integer string.`, { field });
  }
  return BigInt(raw);
}

function exactUint(value, field) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/u.test(raw)) throw new ValidationError(`${field} must be an exact uint256 string.`, { field });
  return BigInt(raw);
}

function bytes32(value, field) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/u.test(raw)) throw new ValidationError(`${field} must be bytes32 hex.`, { field });
  return raw;
}

function signature(value, field) {
  const raw = String(value ?? "").trim();
  if (!/^0x[0-9a-fA-F]{130}$/u.test(raw)) {
    throw new ValidationError(`${field} must be a 65-byte hex signature.`, { field });
  }
  return raw;
}

function loan(value, loanId) {
  if (!value || loanId === ZERO_BYTES32) return null;
  return {
    loanId: String(loanId).toLowerCase(),
    borrower: getAddress(value.borrower ?? value[0]),
    mode: Number(value.mode ?? value[1]),
    principalRaw: BigInt(value.principalRaw ?? value[2]),
    outstandingRaw: BigInt(value.outstandingRaw ?? value[3]),
    termsHash: String(value.termsHash ?? value[4]).toLowerCase(),
    originatedAt: Number(value.originatedAt ?? value[5]),
    closedAt: Number(value.closedAt ?? value[6])
  };
}

export class EvmCreditBookChainReader {
  constructor(provider) {
    this.provider = provider;
  }

  async readSnapshot({ creditBookAddress, wallet }) {
    const blockNumber = Number(await this.provider.getBlockNumber());
    const block = await this.provider.getBlock(blockNumber);
    const at = { blockTag: blockNumber };
    const book = new Contract(creditBookAddress, CREDIT_BOOK_ABI, this.provider);
    const [
      asset, operator, accounts, cashCap, postingCap, bookCap, interestBps, repayBps,
      totalOutstanding, accountedLiquidity, bookLiquid, l3Enabled, l3PosterWallet,
      perWalletCapCeiling, bookCapCeiling, interestBpsCeiling, cashOutstanding,
      postingOutstanding, cashLoanId, postingLoanId
    ] = await Promise.all([
      book.asset(at), book.operator(at), book.accounts(at), book.cashPerWalletCapRaw(at),
      book.postingPerWalletCapRaw(at), book.bookCapRaw(at), book.interestBps(at),
      book.repayBps(at), book.totalOutstandingRaw(at), book.accountedLiquidityRaw(at),
      book.bookLiquidRaw(at), book.l3Enabled(at), book.l3PosterWallet(at),
      book.PER_WALLET_CAP_CEILING_RAW(at), book.BOOK_CAP_CEILING_RAW(at),
      book.INTEREST_BPS_CEILING(at), book.outstandingByModeRaw(wallet, CASH, at),
      book.outstandingByModeRaw(wallet, POSTING, at), book.activeLoanByMode(wallet, CASH, at),
      book.activeLoanByMode(wallet, POSTING, at)
    ]);
    const [cashLoanValue, postingLoanValue] = await Promise.all([
      String(cashLoanId).toLowerCase() === ZERO_BYTES32 ? null : book.loans(cashLoanId, at),
      String(postingLoanId).toLowerCase() === ZERO_BYTES32 ? null : book.loans(postingLoanId, at)
    ]);
    return {
      blockNumber,
      blockHash: block?.hash ?? null,
      blockTimestamp: block?.timestamp === undefined ? null : Number(block.timestamp),
      asset, operator, accounts, cashCap, postingCap, bookCap, interestBps, repayBps,
      totalOutstanding, accountedLiquidity, bookLiquid, l3Enabled, l3PosterWallet,
      perWalletCapCeiling, bookCapCeiling, interestBpsCeiling, cashOutstanding,
      postingOutstanding,
      cashLoan: loan(cashLoanValue, String(cashLoanId).toLowerCase()),
      postingLoan: loan(postingLoanValue, String(postingLoanId).toLowerCase())
    };
  }
}

export class CreditBookDoorService {
  constructor({
    creditBookAddress,
    agentAccountAddress,
    chainId,
    provider,
    chainReader,
    underwriter,
    stateStore,
    gateway,
    externalPostingService,
    siweDomain = "localhost",
    publicBaseUrl = "http://localhost",
    now = () => new Date()
  } = {}) {
    this.creditBookAddress = creditBookAddress ? getAddress(creditBookAddress) : "";
    this.agentAccountAddress = agentAccountAddress ? getAddress(agentAccountAddress) : "";
    this.chainId = Number(chainId);
    this.chainReader = chainReader ?? (provider ? new EvmCreditBookChainReader(provider) : undefined);
    this.underwriter = underwriter;
    this.stateStore = stateStore;
    this.gateway = gateway;
    this.externalPostingService = externalPostingService;
    this.siweDomain = String(siweDomain);
    this.consentUri = new URL("/credit/consent", publicBaseUrl).toString();
    this.now = now;
  }

  async getInfo(walletInput) {
    if (!this.creditBookAddress) return unavailable();
    this.#assertReady();
    const wallet = getAddress(walletInput);
    let snapshot;
    try {
      snapshot = normalizeSnapshot(await this.chainReader.readSnapshot({
        creditBookAddress: this.creditBookAddress,
        wallet
      }));
    } catch {
      return {
        schemaVersion: 1,
        available: false,
        reason: "credit_book_live_read_failed"
      };
    }
    const underwriting = await this.underwriter.evaluate({
      wallet,
      asset: snapshot.asset,
      cashCapRaw: snapshot.cashCap,
      postingCapRaw: snapshot.postingCap
    });
    const cashLimit = BigInt(underwriting.cashLimitRaw);
    const postingLimit = BigInt(underwriting.postingLimitRaw);
    const cashHeadroom = cashLimit > snapshot.cashOutstanding ? cashLimit - snapshot.cashOutstanding : 0n;
    const postingHeadroom = postingLimit > snapshot.postingOutstanding
      ? postingLimit - snapshot.postingOutstanding
      : 0n;
    return {
      schemaVersion: 1,
      available: true,
      pilotTrust: "platform_underwritten_protocol_book",
      creditBook: this.creditBookAddress,
      asset: snapshot.asset,
      chainId: this.chainId,
      block: blockProof(snapshot),
      schedule: {
        interestBps: Number(snapshot.interestBps),
        maxInterestBps: Number(snapshot.interestBpsCeiling),
        repayBps: Number(snapshot.repayBps),
        bookCap: amount(snapshot.bookCap),
        maxBookCap: amount(snapshot.bookCapCeiling),
        perWalletCapCeiling: amount(snapshot.perWalletCapCeiling),
        l3Enabled: snapshot.l3Enabled
      },
      book: {
        liquid: amount(snapshot.bookLiquid),
        accountedLiquidity: amount(snapshot.accountedLiquidity),
        outstanding: amount(snapshot.totalOutstanding),
        headroom: amount(snapshot.bookCap > snapshot.totalOutstanding ? snapshot.bookCap - snapshot.totalOutstanding : 0n),
        l3PosterWallet: snapshot.l3PosterWallet
      },
      underwriting,
      wallet: {
        address: wallet,
        cash: modeView(snapshot.cashLoan, cashLimit, cashHeadroom, snapshot.cashOutstanding, snapshot.cashCap),
        posting: modeView(snapshot.postingLoan, postingLimit, postingHeadroom, snapshot.postingOutstanding, snapshot.postingCap),
        nextSweep: {
          status: snapshot.cashOutstanding + snapshot.postingOutstanding > 0n
            ? "awaiting_next_settlement"
            : "no_open_loan",
          estimate: null,
          reason: "next_settlement_amount_unknown",
          formula: `min(payout × ${snapshot.repayBps.toString()}bps, outstanding)`
        }
      },
      disclosure: {
        deduction: CREDIT_DEDUCTION_DISCLOSURE,
        platformSweep: CREDIT_PLATFORM_SWEEP_DISCLOSURE
      }
    };
  }

  async buildTransactions(walletInput, input = {}) {
    const wallet = getAddress(walletInput);
    const direction = String(input?.direction ?? "").trim();
    if (direction === "cash_consent") return this.#buildConsent(wallet, input, CASH);
    if (direction === "posting_consent") return this.#buildConsent(wallet, input, POSTING);
    throw new ValidationError(
      "direction must be cash_consent or posting_consent.",
      { field: "direction" }
    );
  }

  async storeConsent(walletInput, input = {}) {
    this.#assertReady();
    const wallet = getAddress(walletInput);
    const terms = input?.terms;
    if (!terms || typeof terms !== "object" || Array.isArray(terms)) {
      throw new ValidationError("terms must be the unmodified object returned by buildCreditTransactions.");
    }
    const termsHash = hashCanonicalContent(terms).toLowerCase();
    if (bytes32(input.termsHash, "termsHash") !== termsHash) {
      throw new ConflictError("Consent terms no longer reproduce termsHash.", "credit_terms_hash_mismatch");
    }
    this.#assertTermsBinding(wallet, terms);
    const consentSignature = signature(input.consentSignature, "consentSignature");
    const consentMessage = this.#consentMessage(terms, termsHash);
    const verifiedConsent = verifySiweMessage(consentMessage, consentSignature, {
      expectedDomain: this.siweDomain,
      expectedChainId: this.chainId
    });
    if (
      getAddress(verifiedConsent.recoveredAddress) !== wallet
      || verifiedConsent.uri !== this.consentUri
      || verifiedConsent.nonce !== terms.consentNonce
    ) {
      throw new ConflictError("Credit consent signature does not match the signed-in wallet.", "credit_consent_signer_mismatch");
    }
    const liveInfo = await this.getInfo(wallet);
    if (!liveInfo.available) {
      throw new ConflictError("CreditBook live state is unavailable.", "credit_book_live_read_failed");
    }
    this.#assertLiveTerms(liveInfo, terms);

    const authorizations = (input.repaymentAuthorizations ?? []).map((authorization, index) =>
      this.#verifyRepaymentAuthorization(wallet, terms, authorization, index)
    );
    if (authorizations.length === 0) {
      throw new ValidationError("At least one exact sendToAgentFor repayment authorization is required.");
    }
    const signedBlob = {
      hash: termsHash,
      kind: "credit_book_consent_v1",
      wallet,
      terms,
      termsHash,
      consentMessage,
      consentSignature,
      repaymentAuthorizations: authorizations,
      storedAt: this.now().toISOString()
    };
    await this.stateStore.upsertContent(signedBlob);
    return signedBlob;
  }

  async getConsent(termsHashInput) {
    const termsHash = bytes32(termsHashInput, "termsHash");
    const record = await this.stateStore.getContent(termsHash);
    if (!record || record.kind !== "credit_book_consent_v1") {
      throw new NotFoundError("Credit consent not found.", "credit_consent_not_found");
    }
    return record;
  }

  async originateConsentedLoan(termsHashInput) {
    const consent = await this.getConsent(termsHashInput);
    const info = await this.getInfo(consent.wallet);
    if (!info.available) {
      throw new ConflictError("CreditBook live state is unavailable.", "credit_book_live_read_failed");
    }
    this.#assertLiveTerms(info, consent.terms);
    const mode = consent.terms.mode === "CASH" ? CASH : POSTING;
    const modeInfo = mode === CASH ? info.wallet.cash : info.wallet.posting;
    const amountRaw = BigInt(consent.terms.amountRaw);
    const activeLoan = modeInfo.activeLoan;
    const matchingActiveLoan = activeLoan
      && activeLoan.termsHash === consent.termsHash
      && activeLoan.mode === mode
      && BigInt(activeLoan.principal.raw) === amountRaw;
    if (activeLoan && !matchingActiveLoan) {
      throw new ConflictError(
        "A different loan is already active for this wallet and mode.",
        "credit_active_loan_mismatch"
      );
    }
    if (consent.origination && !activeLoan) {
      // A completed/closed draw must never be replayed from the same signed
      // terms, even after its active-loan slot has cleared.
      return consent;
    }
    if (!matchingActiveLoan && (!info.underwriting.available || amountRaw > BigInt(modeInfo.headroom.raw))) {
      throw new ConflictError(
        "Current receipt-graph headroom no longer covers the consented amount.",
        "credit_underwriting_changed"
      );
    }

    let draft;
    if (mode === POSTING) {
      if (!info.schedule.l3Enabled) throw new ConflictError("L3 posting credit is disabled.", "credit_l3_disabled");
      if (typeof this.gateway?.getPooledFundingAccount !== "function") {
        throw new ConfigError("L3 posting requires the configured external-poster identity.");
      }
      const livePosterWallet = getAddress(await this.gateway.getPooledFundingAccount());
      if (livePosterWallet !== getAddress(info.book.l3PosterWallet)) {
        throw new ConflictError(
          "CreditBook l3PosterWallet does not match the configured external-poster identity.",
          "credit_l3_poster_mismatch"
        );
      }
      draft = await this.externalPostingService.createDraft(
        consent.wallet,
        consent.terms.jobDefinition,
        { fundingRail: EXTERNAL_FUNDING_RAILS.DIRECT_HUB, escrowPoster: livePosterWallet }
      );
      if (
        draft.status !== "live"
        && BigInt(draft.fundingRequirement?.posterReservedRaw ?? 0) !== amountRaw
      ) {
        throw new ConflictError(
          "The live poster reserve no longer matches the consented posting principal.",
          "credit_posting_quote_changed"
        );
      }
    }

    const originated = matchingActiveLoan
      ? consent.origination ?? { loanId: activeLoan.loanId, recoveredFromChain: true }
      : await this.gateway.originateCreditBookLoan({
          borrower: consent.wallet,
          amountRaw,
          mode,
          termsHash: consent.termsHash
        });
    let updated = {
      ...consent,
      origination: {
        ...originated,
        mode: consent.terms.mode,
        amountRaw: amountRaw.toString()
      }
    };
    // Persist the chain origination before the separate L3 job-creation step.
    // A posting failure can then be retried without attempting a second draw.
    await this.stateStore.upsertContent(updated);

    if (draft && !updated.origination.posting) {
      let posting;
      if (draft.status === "live") {
        posting = draft;
      } else {
        const confirmation = await this.gateway.createEscrowFundedExternalJob(draft);
        posting = await this.externalPostingService.reconcileFinalizedCreation(confirmation);
      }
      updated = {
        ...updated,
        origination: { ...updated.origination, posting }
      };
      await this.stateStore.upsertContent(updated);
    }
    return updated;
  }

  async #buildConsent(wallet, input, mode) {
    this.#assertReady();
    const requested = exactPositiveRaw(input.amount, "amount");
    const consentNonce = String(input.consentNonce ?? "").trim();
    if (!/^[A-Za-z0-9]{8,128}$/u.test(consentNonce)) {
      throw new ValidationError("consentNonce must be an opaque 8-128 character alphanumeric nonce.", { field: "consentNonce" });
    }
    const info = await this.getInfo(wallet);
    if (!info.available) {
      throw new ConflictError("CreditBook live state is unavailable.", "credit_book_live_read_failed");
    }
    const modeInfo = mode === CASH ? info.wallet.cash : info.wallet.posting;
    if (mode === POSTING && !info.schedule.l3Enabled) {
      throw new ConflictError("L3 posting credit is disabled.", "credit_l3_disabled");
    }
    if (requested > BigInt(modeInfo.headroom.raw)) {
      throw new ConflictError("Requested amount exceeds current receipt-graph headroom.", "credit_limit_exceeded", {
        requested: amount(requested), maximum: modeInfo.headroom
      });
    }
    const issuedAt = this.now();
    const authorizationValidUntil = new Date(issuedAt.getTime() + THIRTY_DAYS_SECONDS * 1_000);
    const terms = {
      schemaVersion: 1,
      borrower: wallet,
      creditBook: this.creditBookAddress,
      agentAccount: this.agentAccountAddress,
      asset: info.asset,
      chainId: this.chainId,
      amountRaw: requested.toString(),
      mode: mode === CASH ? "CASH" : "POSTING",
      interestBps: info.schedule.interestBps,
      repayBps: info.schedule.repayBps,
      term: "open_ended",
      consentNonce,
      issuedAt: issuedAt.toISOString(),
      authorizationValidUntil: authorizationValidUntil.toISOString(),
      deductionDisclosure: CREDIT_DEDUCTION_DISCLOSURE,
      platformSweepDisclosure: CREDIT_PLATFORM_SWEEP_DISCLOSURE,
      ...(mode === POSTING ? { jobDefinition: postingDefinition(input.jobDefinition) } : {})
    };
    const termsHash = hashCanonicalContent(terms).toLowerCase();
    const sweepRequests = (input.sweepPlan ?? []).map((entry, index) => {
      const amountRaw = exactPositiveRaw(entry?.amount, `sweepPlan[${index}].amount`);
      const nonce = exactUint(entry?.nonce, `sweepPlan[${index}].nonce`);
      const deadline = exactUint(entry?.deadline, `sweepPlan[${index}].deadline`);
      if (deadline > BigInt(Math.floor(authorizationValidUntil.getTime() / 1_000))) {
        throw new ValidationError(`sweepPlan[${index}].deadline exceeds the rolling 30-day consent window.`);
      }
      return {
        amount: amountRaw.toString(),
        nonce: nonce.toString(),
        deadline: deadline.toString(),
        typedData: transferTypedData({
          chainId: this.chainId,
          agentAccount: this.agentAccountAddress,
          from: wallet,
          recipient: this.creditBookAddress,
          asset: info.asset,
          amount: amountRaw,
          nonce,
          deadline
        })
      };
    });
    return {
      schemaVersion: 1,
      available: true,
      direction: mode === CASH ? "cash_consent" : "posting_consent",
      terms,
      termsHash,
      consent: {
        method: "SIWE_EIP4361",
        message: this.#consentMessage(terms, termsHash),
        submit: { method: "POST", path: "/credit/consent" }
      },
      repaymentAuthorizations: sweepRequests,
      disclosure: info.disclosure
    };
  }

  #verifyRepaymentAuthorization(wallet, terms, input, index) {
    const amountRaw = exactPositiveRaw(input?.amount, `repaymentAuthorizations[${index}].amount`);
    const nonce = exactUint(input?.nonce, `repaymentAuthorizations[${index}].nonce`);
    const deadline = exactUint(input?.deadline, `repaymentAuthorizations[${index}].deadline`);
    const authorizationSignature = signature(
      input?.signature,
      `repaymentAuthorizations[${index}].signature`
    );
    const nowSeconds = BigInt(Math.floor(this.now().getTime() / 1_000));
    const termsDeadline = BigInt(Math.floor(Date.parse(terms.authorizationValidUntil) / 1_000));
    if (deadline <= nowSeconds || deadline > termsDeadline) {
      throw new ConflictError("Repayment authorization is expired or outside the consent window.", "credit_authorization_expired");
    }
    const typedData = transferTypedData({
      chainId: this.chainId,
      agentAccount: this.agentAccountAddress,
      from: wallet,
      recipient: this.creditBookAddress,
      asset: terms.asset,
      amount: amountRaw,
      nonce,
      deadline
    });
    const recovered = verifyTypedData(typedData.domain, typedData.types, typedData.message, authorizationSignature);
    if (getAddress(recovered) !== wallet) {
      throw new ConflictError("Repayment authorization signer does not match borrower.", "credit_authorization_signer_mismatch");
    }
    return {
      from: wallet,
      recipient: this.creditBookAddress,
      asset: getAddress(terms.asset),
      amount: amountRaw.toString(),
      nonce: nonce.toString(),
      deadline: deadline.toString(),
      signature: authorizationSignature
    };
  }

  #assertTermsBinding(wallet, terms) {
    if (
      getAddress(terms.borrower) !== wallet
      || getAddress(terms.creditBook) !== this.creditBookAddress
      || getAddress(terms.agentAccount) !== this.agentAccountAddress
      || Number(terms.chainId) !== this.chainId
      || !["CASH", "POSTING"].includes(terms.mode)
      || terms.term !== "open_ended"
      || !/^[A-Za-z0-9]{8,128}$/u.test(String(terms.consentNonce ?? ""))
      || !/^[1-9]\d*$/u.test(String(terms.amountRaw ?? ""))
      || Number(terms.interestBps) !== 0
      || !Number.isInteger(Number(terms.repayBps))
      || Number(terms.repayBps) <= 0
      || Number(terms.repayBps) > 10_000
      || terms.deductionDisclosure !== CREDIT_DEDUCTION_DISCLOSURE
      || terms.platformSweepDisclosure !== CREDIT_PLATFORM_SWEEP_DISCLOSURE
    ) {
      throw new ConflictError("Credit consent is not bound to this wallet and deployment.", "credit_consent_binding_mismatch");
    }
    const issuedAt = Date.parse(terms.issuedAt);
    const validUntil = Date.parse(terms.authorizationValidUntil);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(validUntil) || validUntil - issuedAt !== THIRTY_DAYS_SECONDS * 1_000) {
      throw new ConflictError("Credit consent does not carry the exact rolling 30-day authorization window.", "credit_consent_window_mismatch");
    }
    if (
      terms.mode === "POSTING"
      && (
        !terms.jobDefinition
        || typeof terms.jobDefinition !== "object"
        || Array.isArray(terms.jobDefinition)
        || terms.jobDefinition.onboardingWaiverEligible !== false
      )
    ) {
      throw new ConflictError("Posting consent must bind a non-waived external job definition.", "credit_posting_terms_invalid");
    }
  }

  #assertLiveTerms(info, terms) {
    if (
      getAddress(terms.asset) !== getAddress(info.asset)
      || Number(terms.interestBps) !== Number(info.schedule.interestBps)
      || Number(terms.repayBps) !== Number(info.schedule.repayBps)
    ) {
      throw new ConflictError(
        "The signed credit schedule no longer matches live CreditBook policy.",
        "credit_schedule_changed"
      );
    }
  }

  #assertReady() {
    if (
      !this.creditBookAddress || !this.agentAccountAddress || !this.chainReader || !this.underwriter
      || !this.stateStore || !Number.isSafeInteger(this.chainId) || this.chainId <= 0
    ) throw new ConfigError("CreditBook door is not fully configured.");
  }

  #consentMessage(terms, termsHash) {
    return buildConsentMessage(terms, termsHash, {
      domain: this.siweDomain,
      uri: this.consentUri,
      chainId: this.chainId
    });
  }
}

export function buildConsentMessage(terms, termsHash, { domain, uri, chainId }) {
  return buildSiweMessage({
    domain,
    address: terms.borrower,
    statement: `Authorize Averray CreditBook terms ${termsHash}. Terms JSON: ${canonicalizeContent(terms)}`,
    uri,
    chainId,
    nonce: terms.consentNonce,
    issuedAt: terms.issuedAt,
    expirationTime: terms.authorizationValidUntil
  });
}

export function transferTypedData({ chainId, agentAccount, from, recipient, asset, amount, nonce, deadline }) {
  return {
    domain: {
      name: "Averray AgentAccountCore",
      version: "1",
      chainId,
      verifyingContract: getAddress(agentAccount)
    },
    types: {
      SendToAgent: [
        { name: "from", type: "address" },
        { name: "recipient", type: "address" },
        { name: "asset", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ]
    },
    message: {
      from: getAddress(from),
      recipient: getAddress(recipient),
      asset: getAddress(asset),
      amount: BigInt(amount),
      nonce: BigInt(nonce),
      deadline: BigInt(deadline)
    }
  };
}

function postingDefinition(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("jobDefinition is required for posting credit.", { field: "jobDefinition" });
  }
  if (input.onboardingWaiverEligible === true) {
    throw new ValidationError("Credit-funded external jobs cannot request onboarding waiver eligibility.");
  }
  return { ...input, onboardingWaiverEligible: false };
}

function modeView(activeLoan, limit, headroom, outstanding, cap) {
  let presentedLoan = null;
  if (activeLoan) {
    const { principalRaw, outstandingRaw, ...metadata } = activeLoan;
    presentedLoan = {
      ...metadata,
      principal: amount(principalRaw),
      outstanding: amount(outstandingRaw)
    };
  }
  return {
    limit: amount(limit),
    cap: amount(cap),
    outstanding: amount(outstanding),
    headroom: amount(headroom),
    activeLoan: presentedLoan
  };
}

function normalizeSnapshot(input) {
  const output = {
    ...input,
    asset: getAddress(input.asset),
    operator: getAddress(input.operator),
    accounts: getAddress(input.accounts),
    l3PosterWallet: getAddress(input.l3PosterWallet),
    blockNumber: Number(input.blockNumber)
  };
  for (const key of [
    "cashCap", "postingCap", "bookCap", "interestBps", "repayBps", "totalOutstanding",
    "accountedLiquidity", "bookLiquid", "perWalletCapCeiling", "bookCapCeiling",
    "interestBpsCeiling", "cashOutstanding", "postingOutstanding"
  ]) output[key] = BigInt(input[key]);
  return output;
}

function blockProof(snapshot) {
  return {
    number: snapshot.blockNumber,
    hash: snapshot.blockHash ?? null,
    ...(snapshot.blockTimestamp === null || snapshot.blockTimestamp === undefined
      ? {}
      : {
          timestamp: snapshot.blockTimestamp,
          timestampIso: new Date(snapshot.blockTimestamp * 1_000).toISOString()
        })
  };
}

function unavailable() {
  return { schemaVersion: 1, available: false, reason: "credit_book_not_configured" };
}

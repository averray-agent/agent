const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const CALLDATA = /^0x[0-9a-f]+$/iu;

function validTemplate(template, { wallet, chainId, step }) {
  return template
    && typeof template === "object"
    && !Array.isArray(template)
    && template.step === step
    && template.unsigned === true
    && typeof template.from === "string"
    && ADDRESS.test(template.from)
    && template.from.toLowerCase() === wallet.toLowerCase()
    && typeof template.to === "string"
    && ADDRESS.test(template.to)
    && typeof template.data === "string"
    && CALLDATA.test(template.data)
    && template.value === "0"
    && template.chainId === chainId;
}

/**
 * Fail-closed projection from the authenticated backend intent to wallet RPC
 * calls. The app never accepts keys, signatures, or caller-authored calldata.
 */
export function accountDepositTransactionsFromIntent(intent, wallet) {
  if (!wallet || !ADDRESS.test(wallet) || !intent || typeof intent !== "object") return null;
  const chainId = Number(intent.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  if (!Array.isArray(intent.templates) || intent.templates.length !== 2) return null;
  const [approve, deposit] = intent.templates;
  if (!validTemplate(approve, { wallet, chainId, step: "approve" })) return null;
  if (!validTemplate(deposit, { wallet, chainId, step: "deposit" })) return null;
  if (deposit.prerequisite !== "approve_confirmed_on_chain") return null;

  return [approve, deposit].map((template) => ({
    from: template.from,
    to: template.to,
    data: template.data,
    value: "0x0"
  }));
}

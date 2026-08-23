function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value : "";
}

/** Fail closed on the backend's unsigned withdrawal template before signing. */
export function withdrawalTransactionFromIntent(intent, wallet) {
  const record = asRecord(intent);
  const templates = Array.isArray(record.templates) ? record.templates : [];
  const template = asRecord(templates.find((entry) => asRecord(entry).step === "withdraw"));
  const from = text(template.from);
  const to = text(template.to);
  const data = text(template.data);
  if (
    template.unsigned !== true
    || typeof wallet !== "string"
    || from.toLowerCase() !== wallet.toLowerCase()
    || !/^0x[0-9a-f]{40}$/iu.test(to)
    || !/^0x[0-9a-f]+$/iu.test(data)
  ) return null;
  return { from: wallet, to, data, value: "0x0" };
}

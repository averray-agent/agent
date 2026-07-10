const COLUMNS = [
  "id",
  "day",
  "at",
  "source",
  "category",
  "action",
  "summary",
  "actor_handle",
  "actor_address",
  "target",
  "hash",
  "link_label",
  "link_href",
];

export function auditEventsToCsv(events) {
  const rows = (Array.isArray(events) ? events : []).map((event) => [
    event?.id,
    event?.day,
    event?.at,
    event?.source,
    event?.category,
    event?.action,
    event?.summary,
    event?.actor?.handle,
    event?.actor?.address,
    event?.target,
    event?.hash,
    event?.link?.label,
    event?.link?.href,
  ]);
  return [COLUMNS, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

function csvCell(value) {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

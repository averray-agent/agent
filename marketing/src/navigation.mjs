/**
 * Public-site wayfinding, kept as data so the navigation component and the
 * reachability guard read the same set of doors.
 *
 * Verify leads because it is the only paid public surface. Work and Record
 * group related destinations without hiding them behind homepage copy.
 */
export const PRIMARY_NAV_ITEMS = Object.freeze([
  { key: "verify", label: "Verify", href: "/verify/" },
  {
    key: "work",
    label: "Work",
    children: Object.freeze([
      { key: "agents", label: "Agents", href: "/agents/" },
      { key: "schemas", label: "Schemas", href: "/schemas/" },
      { key: "proof-to-pay", label: "Proof to pay", href: "/proof-to-pay/" }
    ])
  },
  { key: "pool", label: "Pool", href: "/pool/" },
  {
    key: "record",
    label: "Record",
    children: Object.freeze([
      { key: "transparency", label: "Transparency", href: "/transparency/" },
      { key: "receipts", label: "Receipts", href: "/receipts/" }
    ])
  },
  { key: "builders", label: "Builders", href: "/builders/" },
  { key: null, label: "Install MCP", href: "/builders/#install" }
]);

export function primaryNavLinks(items = PRIMARY_NAV_ITEMS) {
  return items.flatMap((item) => item.children ?? [item]);
}

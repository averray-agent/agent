import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  Coins,
  FileCheck2,
  Gauge,
  History,
  KeyRound,
  LayoutDashboard,
  Megaphone,
  ScrollText,
  ShieldCheck,
  Users,
} from "lucide-react";

export interface OperatorNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  count?: number | string;
}

export interface OperatorNavGroup {
  label: string;
  items: OperatorNavItem[];
}

export const OPERATOR_NAV_GROUPS: OperatorNavGroup[] = [
  {
    label: "Room",
    items: [
      { href: "/overview", label: "Overview", icon: LayoutDashboard },
      { href: "/runs", label: "Runs", icon: Gauge },
      { href: "/receipts", label: "Receipts", icon: ScrollText },
      { href: "/agents", label: "Agents", icon: Users },
    ],
  },
  {
    label: "Capital",
    items: [
      { href: "/treasury", label: "Treasury", icon: Coins },
      { href: "/poster", label: "Posting", icon: Megaphone },
      { href: "/sessions", label: "Sessions", icon: History },
    ],
  },
  {
    label: "Governance",
    items: [
      { href: "/policies", label: "Policies", icon: ShieldCheck },
      { href: "/capabilities", label: "Capabilities", icon: KeyRound },
      { href: "/disputes", label: "Disputes", icon: AlertTriangle },
      { href: "/audit-log", label: "Audit log", icon: FileCheck2 },
    ],
  },
];

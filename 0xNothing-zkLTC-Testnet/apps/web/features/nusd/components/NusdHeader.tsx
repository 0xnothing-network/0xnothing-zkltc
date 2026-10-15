"use client";

import { usePathname } from "next/navigation";
import { ProductHeader, type HeaderNotice } from "@/components/ProductHeader";
import { useToast } from "@fi/components/Toast";

const NUSD_NAV = [
  { href: "/nusd", label: "Mint" },
  { href: "/nusd/earn", label: "Earn" },
] as const;

function isActiveRoute(pathname: string, href: string): boolean {
  if (href === "/nusd") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NusdHeader() {
  const pathname = usePathname();
  const toast = useToast();
  const notify: HeaderNotice = (kind, title, message) => toast.show(title, message ?? "", kind);
  return <ProductHeader product="nusd" nav={NUSD_NAV} isActive={(href) => isActiveRoute(pathname, href)} notify={notify} />;
}

"use client";

import { usePathname } from "next/navigation";
import { ProductHeader, type HeaderNotice } from "@/components/ProductHeader";
import { useToast } from "@/components/Toast";

const PUMP_NAV = [
  { href: "/0xPump", label: "Discover" },
  { href: "/0xPump/create", label: "Create" },
  { href: "/0xPump/portfolio", label: "Portfolio" },
  { href: "/0xPump/stats", label: "Stats" },
] as const;

function isActiveRoute(pathname: string, href: string): boolean {
  if (href === "/0xPump") return pathname === href || pathname.startsWith("/0xPump/token/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PumpHeader() {
  const pathname = usePathname();
  const toast = useToast();
  const notify: HeaderNotice = (kind, title, message) => {
    if (kind === "success") toast.success(title, message);
    else if (kind === "warning") toast.warning(title, message);
    else toast.error(title, message);
  };
  return <ProductHeader product="pump" nav={PUMP_NAV} isActive={(href) => isActiveRoute(pathname, href)} notify={notify} />;
}

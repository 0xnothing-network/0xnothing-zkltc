import type { ReactNode } from "react";
import { type MessageKey, t } from "../../core/i18n";
import type { RouteName } from "../router";

/**
 * The three-way bottom bar from the wireframe. HOME is also the parent of the
 * send/receive/history/mint/lend screens, so it stays highlighted while any of
 * them is open — the user has not left home, they went one level in.
 */
const HOME_FAMILY = new Set<RouteName>([
  "home",
  "send",
  "receive",
  "history",
  "mint",
  "lend",
  "settings",
]);

const ITEMS: readonly { name: RouteName; label: MessageKey; glyph: string; path: string }[] = [
  { name: "home", label: "nav.home", glyph: "▣", path: "#/" },
  { name: "swap", label: "nav.swap", glyph: "⇄", path: "#/swap" },
  { name: "dapps", label: "nav.dapp", glyph: "◎", path: "#/dapps" },
];

export function BottomNav({ current }: { current: RouteName }): ReactNode {
  return (
    <nav className="w-nav" aria-label={t("nav.aria")}>
      {ITEMS.map((item) => {
        const active = item.name === "home" ? HOME_FAMILY.has(current) : current === item.name;
        return (
          <a
            key={item.name}
            className="w-nav-item"
            href={item.path}
            aria-current={active ? "page" : undefined}
          >
            <span className="w-nav-glyph" aria-hidden="true">
              {item.glyph}
            </span>
            {t(item.label)}
          </a>
        );
      })}
    </nav>
  );
}

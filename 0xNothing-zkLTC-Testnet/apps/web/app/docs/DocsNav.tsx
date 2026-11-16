"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";

type NavGroup = { readonly label: string; readonly items: readonly { readonly href: string; readonly label: string }[] };

/** Desktop sidebar: marks the link of the section in view with aria-current. */
export function DocsSidebarNav({ groups }: { groups: readonly NavGroup[] }) {
  const [current, setCurrent] = useState("");

  useEffect(() => {
    const ids = groups.flatMap((group) => group.items.map((item) => item.href.slice(1)));
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      const first = ids.find((id) => visible.has(id));
      if (first) setCurrent(first);
    }, { rootMargin: "-88px 0px -55% 0px" });
    for (const id of ids) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, [groups]);

  return (
    <nav aria-label="Documentation navigation">
      {groups.map((group) => (
        <div className="ox-docs-nav-group" key={group.label}>
          <strong>{group.label}</strong>
          {group.items.map((item) => (
            <a href={item.href} key={item.href} aria-current={current === item.href.slice(1) ? "location" : undefined}>{item.label}</a>
          ))}
        </div>
      ))}
    </nav>
  );
}

/** Mobile contents: closes after a link is tapped so the section is not covered. */
export function DocsMobileNav({ groups }: { groups: readonly NavGroup[] }) {
  const details = useRef<HTMLDetailsElement>(null);
  function closeOnLink(event: MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("a") && details.current) details.current.open = false;
  }
  return (
    <details className="ox-docs-mobile-nav" ref={details}>
      <summary>Browse documentation</summary>
      <nav aria-label="Mobile documentation navigation" onClick={closeOnLink}>
        {groups.map((group) => group.items.map((item) => <a href={item.href} key={item.href}>{item.label}</a>))}
      </nav>
    </details>
  );
}

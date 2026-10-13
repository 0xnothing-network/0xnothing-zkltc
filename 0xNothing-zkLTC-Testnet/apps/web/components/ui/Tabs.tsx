"use client";

import { useRef } from "react";
import type { KeyboardEvent } from "react";
import { cx } from "./cx";

export interface TabItem<T extends string> {
  value: T;
  label: string;
}

/** Underline tabs (role=tablist). Panels should set aria-labelledby={`${idBase}-tab-${value}`}. */
export function Tabs<T extends string>({
  label, value, items, onChange, idBase, className,
}: { label: string; value: T; items: ReadonlyArray<TabItem<T>>; onChange: (value: T) => void; idBase: string; className?: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + items.length) % items.length;
    onChange(items[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={cx("flex gap-5 border-b border-line", className)}>
      {items.map((item, index) => {
        const on = item.value === value;
        return (
          <button
            key={item.value}
            ref={(node) => { refs.current[index] = node; }}
            id={`${idBase}-tab-${item.value}`}
            role="tab"
            type="button"
            aria-selected={on}
            aria-controls={`${idBase}-panel-${item.value}`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cx(
              "relative -mb-px h-10 font-ui text-sm font-medium border-b-2 transition-colors duration-[180ms] focus-ring",
              on ? "text-fg border-accent" : "text-fg-3 border-transparent hover:text-fg-2",
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

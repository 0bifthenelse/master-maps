"use client";

import { useEffect, useRef } from "react";
import { Icon, type IconName } from "./Icon";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon: IconName;
  onSelect: () => void;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  title: string;
  subtitle: string;
  items: readonly ContextMenuItem[];
  onDismiss: () => void;
}

/** Right-click / long-press menu, kept inside the viewport and fully keyboard operable. */
export default function ContextMenu({ x, y, title, subtitle, items, onDismiss }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    element.querySelector<HTMLButtonElement>("button")?.focus();
    const onPointer = (event: PointerEvent): void => {
      if (!element.contains(event.target as Node)) onDismiss();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const buttons = [...element.querySelectorAll<HTMLButtonElement>("button")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [x, y, onDismiss]);
  return (
    <div ref={ref} className="mm-menu mm-panel mm-brackets" role="menu" aria-label={title} style={{ left: x, top: y }}>
      <div className="mm-menu__head">
        <div style={{ fontFamily: "var(--mm-font-display)", fontWeight: 700, fontSize: 15 }}>{title}</div>
        <div className="mm-tag" style={{ marginTop: 2 }}>{subtitle}</div>
      </div>
      {items.map((item) => (
        <button key={item.id} type="button" role="menuitem" className="mm-menu__item" onClick={() => { item.onSelect(); onDismiss(); }}>
          <Icon name={item.icon} />
          {item.label}
        </button>
      ))}
    </div>
  );
}

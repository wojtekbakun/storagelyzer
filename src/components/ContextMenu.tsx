import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type MenuEntry =
  | { separator: true }
  | { separator?: false; label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; onSelect(): void };

interface Props {
  x: number;
  y: number;
  title?: string;
  items: MenuEntry[];
  onClose(): void;
}

export function ContextMenu({ x, y, title, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos({
      left: Math.max(6, Math.min(x, window.innerWidth - w - 6)),
      top: Math.max(6, y + h > window.innerHeight - 6 ? y - h : y),
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div className="menu" ref={ref} style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {title ? <div className="menu-title">{title}</div> : null}
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item ${it.danger ? "is-danger" : ""}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            <span className="menu-icon">{it.icon}</span>
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

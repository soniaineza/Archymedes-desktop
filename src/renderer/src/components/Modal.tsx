import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

interface Props {
  onClose: () => void;
  labelledBy?: string;
  label?: string;
  className?: string;
  /** "top" suits command palettes; "center" suits dialogs. */
  position?: "center" | "top";
  children: ReactNode;
}

/** Accessible dialog shell: Escape and backdrop close it, focus moves in and is restored on close. */
export function Modal({ onClose, labelledBy, label, className, position = "center", children }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);

  return (
    <div
      className={`modal-backdrop ${position}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}

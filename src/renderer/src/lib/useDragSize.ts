import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drag-to-resize for panes. Size persists to localStorage; double-click the
 * handle to reset. `sign` flips which drag direction grows the pane:
 * +1 = dragging toward positive axis grows it (left sidebar), -1 = the
 * opposite (right-hand agent panel, bottom-docked terminal).
 */
export function useDragSize(
  key: string,
  initial: number,
  min: number,
  max: number,
  axis: "x" | "y",
  sign: 1 | -1,
): [number, (e: React.MouseEvent) => void, () => void] {
  const clamp = useCallback(
    (n: number): number => Math.max(min, Math.min(max, n)),
    [min, max],
  );

  const [size, setSize] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem(key));
      if (Number.isFinite(stored) && stored >= min && stored <= max) return stored;
    } catch {
      // storage unavailable; fall through to initial
    }
    return initial;
  });
  const draggingRef = useRef(false);

  const readCoord = (e: MouseEvent | React.MouseEvent): number =>
    axis === "x" ? e.clientX : e.clientY;

  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const start = readCoord(e);
      const startSize = size;
      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        setSize(clamp(startSize + sign * (readCoord(ev) - start)));
      };
      const onUp = () => {
        draggingRef.current = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [axis, clamp, sign, size],
  );

  const reset = useCallback(() => setSize(initial), [initial]);

  // Persist once the drag settles (and on any programmatic change).
  useEffect(() => {
    try {
      localStorage.setItem(key, String(size));
    } catch {
      // storage unavailable; resizing still works this session
    }
  }, [key, size]);

  return [size, startDrag, reset];
}

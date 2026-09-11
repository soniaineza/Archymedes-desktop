import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

/** Where the panel is docked; decides which drag direction grows it (RTL-aware). */
type Dock = "start" | "end" | "bottom";

interface Options {
  storageKey: string;
  initial: number;
  min: number;
  max: number;
  dock: Dock;
}

const KEY_STEP = 16;

function readStored(key: string, min: number, max: number, fallback: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return value >= min && value <= max ? value : fallback;
  } catch {
    return fallback;
  }
}

export function useResizable({ storageKey, initial, min, max, dock }: Options) {
  const [size, setSize] = useState(() => readStored(storageKey, min, max, initial));
  const [dragging, setDragging] = useState(false);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useEffect(() => {
    if (dragging) return;
    try {
      localStorage.setItem(storageKey, String(size));
    } catch {
      // sizes are a convenience; ignore storage failures
    }
  }, [dragging, size, storageKey]);

  const growthFor = useCallback(
    (dx: number, dy: number): number => {
      if (dock === "bottom") return -dy;
      const towardEnd = document.documentElement.dir === "rtl" ? -dx : dx;
      return dock === "start" ? towardEnd : -towardEnd;
    },
    [dock],
  );

  const clamp = useCallback((value: number) => Math.round(Math.min(max, Math.max(min, value))), [max, min]);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      const startX = e.clientX;
      const startY = e.clientY;
      const startSize = sizeRef.current;
      handle.setPointerCapture(e.pointerId);
      setDragging(true);

      const move = (ev: globalThis.PointerEvent) => {
        setSize(clamp(startSize + growthFor(ev.clientX - startX, ev.clientY - startY)));
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        setDragging(false);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    },
    [clamp, growthFor],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-KEY_STEP, 0],
        ArrowRight: [KEY_STEP, 0],
        ArrowUp: [0, -KEY_STEP],
        ArrowDown: [0, KEY_STEP],
      };
      const step = delta[e.key];
      if (!step) return;
      e.preventDefault();
      setSize((s) => clamp(s + growthFor(step[0], step[1])));
    },
    [clamp, growthFor],
  );

  return {
    size,
    dragging,
    handleProps: {
      onPointerDown,
      onKeyDown,
      role: "separator" as const,
      tabIndex: 0,
      "aria-orientation": dock === "bottom" ? ("horizontal" as const) : ("vertical" as const),
      "aria-valuenow": size,
      "aria-valuemin": min,
      "aria-valuemax": max,
    },
  };
}

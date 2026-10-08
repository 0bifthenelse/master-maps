import { useSyncExternalStore } from "react";
import type { MapPoint } from "./transform";

/**
 * A tiny external store for the HUD: camera readouts and the cursor position
 * change every frame, and only the components that show them re-render.
 */
export interface ViewSnapshot {
  center: MapPoint;
  zoom: number;
  bearing: number;
  pitch: number;
  metresPerPixel: number;
  width: number;
}

export interface CursorSnapshot {
  /** Local metres under the pointer, or null when the pointer is off the map. */
  point: MapPoint | null;
}

function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  let pending = false;
  return {
    get: (): T => value,
    set(next: T): void {
      value = next;
      if (pending) return;
      pending = true;
      const flush = (): void => {
        pending = false;
        for (const listener of listeners) listener();
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
      else flush();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const viewStore = createStore<ViewSnapshot>({ center: [0, 0], zoom: 10, bearing: 0, pitch: 0, metresPerPixel: 100, width: 1 });
export const cursorStore = createStore<CursorSnapshot>({ point: null });

export function useView(): ViewSnapshot {
  return useSyncExternalStore(viewStore.subscribe, viewStore.get, viewStore.get);
}

export function useCursor(): CursorSnapshot {
  return useSyncExternalStore(cursorStore.subscribe, cursorStore.get, cursorStore.get);
}

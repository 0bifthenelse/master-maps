"use client";

import { useEffect } from "react";

const ROWS: ReadonlyArray<[string[], string]> = [
  [["Drag"], "Pan the map (it glides when thrown)"],
  [["Wheel", "Pinch"], "Zoom around the cursor or fingers"],
  [["Right-drag", "Ctrl + drag"], "Rotate (left/right) and tilt (up/down)"],
  [["Two-finger twist"], "Rotate on touch screens"],
  [["Two-finger slide"], "Tilt on touch screens"],
  [["Double-click"], "Zoom in · Shift: zoom out"],
  [["←", "↑", "→", "↓"], "Pan · also H J K L"],
  [["Shift", "← →"], "Rotate 15°"],
  [["Shift", "↑ ↓"], "Tilt"],
  [["+", "−"], "Zoom in / out"],
  [["N"], "Face north, flatten"],
  [["0"], "Show the whole Gers"],
  [["/"], "Search"],
  [["Esc"], "Close panels"],
  [["?"], "This help"],
];

export default function ShortcutHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" || event.key === "?") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="mm-help" role="dialog" aria-modal="true" aria-label="Keyboard and gesture shortcuts" onClick={onClose}>
      <div className="mm-help__card mm-panel mm-brackets" onClick={(event) => event.stopPropagation()}>
        <div className="mm-tag mm-tag--yellow">Operator manual</div>
        <div style={{ fontFamily: "var(--mm-font-display)", fontWeight: 700, fontSize: 24, marginTop: 4 }}>Navigating the Gers</div>
        <div className="mm-help__grid">
          {ROWS.map(([keys, text]) => (
            <div key={text} style={{ display: "contents" }}>
              <span>{keys.map((key) => <kbd key={key} className="mm-kbd">{key}</kbd>)}</span>
              <span style={{ color: "var(--mm-ink-2)" }}>{text}</span>
            </div>
          ))}
        </div>
        <button type="button" className="mm-action" style={{ marginTop: 18 }} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

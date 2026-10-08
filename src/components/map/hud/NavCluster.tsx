"use client";

import { useRef } from "react";
import { useView } from "@/lib/map/viewStore";
import { Icon } from "./Icon";

export interface NavClusterProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetNorth: () => void;
  onToggleTilt: () => void;
  /** Drag on the compass turns the map; radians, clockwise. */
  onRotateTo: (bearing: number) => void;
  onLocate: () => void;
  onHelp: () => void;
  locating: boolean;
}

/**
 * Zoom, compass and tilt. The compass needle always points at true north on
 * screen; dragging it turns the map, a click restores north up and flat.
 */
export default function NavCluster({ onZoomIn, onZoomOut, onResetNorth, onToggleTilt, onRotateTo, onLocate, onHelp, locating }: NavClusterProps) {
  const view = useView();
  const dragging = useRef<{ startAngle: number; startBearing: number; moved: boolean } | null>(null);
  const compassRef = useRef<HTMLButtonElement | null>(null);
  const degrees = (view.bearing * 180) / Math.PI;
  const tilted = view.pitch > 0.02;

  const angleOf = (event: React.PointerEvent): number => {
    const rect = compassRef.current!.getBoundingClientRect();
    return Math.atan2(event.clientX - (rect.left + rect.width / 2), -(event.clientY - (rect.top + rect.height / 2)));
  };

  return (
    <div className="mm-nav">
      <button type="button" className="mm-icon-button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={onHelp}>
        <Icon name="keyboard" />
      </button>
      <button type="button" className="mm-icon-button" aria-label="Show my location" title="My location" aria-pressed={locating} onClick={onLocate}>
        <Icon name="locate" />
      </button>
      <button type="button" className="mm-icon-button" aria-label={tilted ? "Flat 2D view" : "Tilted 3D view"} title={tilted ? "2D" : "3D"} aria-pressed={tilted} onClick={onToggleTilt}>
        <span style={{ fontFamily: "var(--mm-font-display)", fontWeight: 700, fontSize: 13, letterSpacing: "0.06em" }}>{tilted ? "2D" : "3D"}</span>
      </button>
      <button
        ref={compassRef}
        type="button"
        className="mm-compass"
        aria-label={`Compass, heading ${Math.round(((degrees % 360) + 360) % 360)} degrees. Click to face north.`}
        title="Drag to rotate · click for north"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragging.current = { startAngle: angleOf(event), startBearing: view.bearing, moved: false };
        }}
        onPointerMove={(event) => {
          const drag = dragging.current;
          if (drag === null) return;
          const delta = angleOf(event) - drag.startAngle;
          if (Math.abs(delta) > 0.03) drag.moved = true;
          if (drag.moved) onRotateTo(drag.startBearing - delta);
        }}
        onPointerUp={() => {
          const drag = dragging.current;
          dragging.current = null;
          if (drag !== null && !drag.moved) onResetNorth();
        }}
      >
        <svg className="mm-compass__rose" viewBox="0 0 52 52" style={{ transform: `rotate(${-degrees}deg)` }} aria-hidden="true">
          <circle cx="26" cy="26" r="20" fill="none" stroke="rgba(170,200,225,0.25)" strokeDasharray="1 3" />
          {[0, 90, 180, 270].map((angle) => (
            <line key={angle} x1="26" y1="5" x2="26" y2="9" stroke="rgba(170,200,225,0.6)" transform={`rotate(${angle} 26 26)`} />
          ))}
          <path d="M26 9 L31 27 L26 24 L21 27 Z" fill="#f5c400" />
          <path d="M26 43 L31 27 L26 30 L21 27 Z" fill="rgba(232,238,244,0.55)" />
          <text x="26" y="20" textAnchor="middle" fontSize="0" fill="none">N</text>
        </svg>
        <span className="mm-compass__label">{Math.round(((degrees % 360) + 360) % 360)}°{tilted ? ` · ${Math.round((view.pitch * 180) / Math.PI)}°` : ""}</span>
      </button>
      <div className="mm-nav__zoom" style={{ marginTop: 14 }}>
        <button type="button" className="mm-icon-button" aria-label="Zoom in" title="Zoom in (+)" onClick={onZoomIn}><Icon name="plus" /></button>
        <button type="button" className="mm-icon-button" aria-label="Zoom out" title="Zoom out (−)" onClick={onZoomOut}><Icon name="minus" /></button>
      </div>
    </div>
  );
}

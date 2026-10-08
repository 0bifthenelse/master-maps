"use client";

import { useState } from "react";
import type { BaseMap } from "@/lib/map/theme";

export interface MapLayers {
  labels: boolean;
  places: boolean;
  pois: boolean;
  businesses: boolean;
  addresses: boolean;
  buildings: boolean;
  roads: boolean;
  water: boolean;
  landuse: boolean;
  transport: boolean;
  boundaries: boolean;
  grid: boolean;
}

export const DEFAULT_LAYERS: MapLayers = {
  labels: true,
  places: true,
  pois: true,
  businesses: true,
  addresses: true,
  buildings: true,
  roads: true,
  water: true,
  landuse: true,
  transport: true,
  boundaries: true,
  grid: true,
};

const TOGGLES: ReadonlyArray<[keyof MapLayers, string]> = [
  ["labels", "Labels"],
  ["buildings", "3D buildings"],
  ["pois", "Places of interest"],
  ["businesses", "Companies (SIRENE)"],
  ["addresses", "House numbers"],
  ["roads", "Roads"],
  ["water", "Water"],
  ["landuse", "Land cover"],
  ["transport", "Rail & airfields"],
  ["boundaries", "Boundaries"],
  ["grid", "Survey grid"],
];

export interface LayerDockProps {
  basemap: BaseMap;
  onBasemap: (basemap: BaseMap) => void;
  layers: MapLayers;
  onToggle: (layer: keyof MapLayers, value: boolean) => void;
}

/** Base map switch (Machine vector or IGN aerial imagery) and the layer toggles. */
export default function LayerDock({ basemap, onBasemap, layers, onToggle }: LayerDockProps) {
  const [open, setOpen] = useState(false);
  const other: BaseMap = basemap === "machine" ? "satellite" : "machine";
  return (
    <div className="mm-layers" data-testid="layer-controls">
      <button
        type="button"
        className="mm-basemap"
        aria-label={`Switch to ${other === "satellite" ? "satellite imagery" : "the Machine map"}`}
        title={other === "satellite" ? "Satellite" : "Machine map"}
        onClick={() => onBasemap(other)}
      >
        <span
          className="mm-basemap__swatch"
          style={{
            background: other === "satellite"
              ? "radial-gradient(circle at 30% 30%, #6f7b4c 0, #3f4a2c 35%, #2a3022 60%, #4a4a3a 100%)"
              : "linear-gradient(135deg, #0a0e13 0%, #0a0e13 40%, #f5c400 41%, #f5c400 44%, #0a0e13 45%, #121820 70%, #e8eef4 71%, #e8eef4 73%, #121820 74%)",
          }}
        />
        <span className="mm-basemap__label">{other === "satellite" ? "Satellite" : "Machine"}</span>
      </button>
      <button type="button" className="mm-icon-button" aria-expanded={open} aria-label="Map layers" title="Layers" onClick={() => setOpen((value) => !value)} style={{ height: 78, width: 40 }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /></svg>
      </button>
      {open ? (
        <div className="mm-panel mm-brackets mm-layers__panel" role="group" aria-label="Layers">
          <div className="mm-tag" style={{ marginBottom: 6 }}>Feeds</div>
          {TOGGLES.map(([key, label]) => (
            <button key={key} type="button" role="switch" aria-checked={layers[key]} className="mm-toggle" onClick={() => onToggle(key, !layers[key])}>
              <span>{label}</span>
              <span className="mm-toggle__switch" aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

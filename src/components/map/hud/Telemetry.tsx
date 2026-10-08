"use client";

import { useEffect, useState } from "react";
import { renderToLambert, renderToWgs84 } from "@/lib/geo/crs";
import { useCursor, useView } from "@/lib/map/viewStore";

export interface TelemetryProps {
  tiles: number;
  datasetDate: string | null;
}

const NICE_STEPS = [1, 2, 5];

function scaleBar(metresPerPixel: number, maxPx: number): { px: number; label: string } {
  const maxMetres = metresPerPixel * maxPx;
  let best = 1;
  for (let power = 0; power < 7; power += 1) {
    for (const step of NICE_STEPS) {
      const value = step * 10 ** power;
      if (value <= maxMetres) best = value;
    }
  }
  return { px: best / metresPerPixel, label: best >= 1000 ? `${best / 1000} km` : `${best} m` };
}

function formatCoordinate(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(5)}°${value >= 0 ? positive : negative}`;
}

/** Live instrument readouts: cursor position, scale, zoom, heading, feed and clock. */
export default function Telemetry({ tiles, datasetDate }: TelemetryProps) {
  const view = useView();
  const cursor = useCursor();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const point = cursor.point ?? view.center;
  let latLon = "";
  let lambert = "";
  try {
    const [lon, lat] = renderToWgs84(point);
    const [x, y] = renderToLambert(point);
    latLon = `${formatCoordinate(lat, "N", "S")} ${formatCoordinate(lon, "E", "W")}`;
    lambert = `${Math.round(x)} ${Math.round(y)}`;
  } catch {
    latLon = "—";
  }
  const scale = scaleBar(view.metresPerPixel, 110);
  const heading = Math.round((((view.bearing * 180) / Math.PI) % 360 + 360) % 360);
  const time = now.toLocaleTimeString("en-GB", { hour12: false, timeZone: "Europe/Paris" });
  const date = now.toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
  return (
    <div className="mm-telemetry" aria-label="Map telemetry">
      <span className="mm-telemetry__item mm-telemetry__live">● LIVE FEED</span>
      <span className="mm-telemetry__item"><span className="mm-telemetry__key">{cursor.point === null ? "CENTRE" : "CURSOR"}</span><span className="mm-telemetry__value">{latLon}</span></span>
      <span className="mm-telemetry__item mm-telemetry__desktop"><span className="mm-telemetry__key">L93</span><span className="mm-telemetry__value">{lambert}</span></span>
      <span className="mm-telemetry__item"><span className="mm-telemetry__key">Z</span><span className="mm-telemetry__value">{view.zoom.toFixed(1)}</span></span>
      <span className="mm-telemetry__item mm-telemetry__desktop"><span className="mm-telemetry__key">HDG</span><span className="mm-telemetry__value">{String(heading).padStart(3, "0")}°</span></span>
      <span className="mm-telemetry__item mm-telemetry__desktop"><span className="mm-telemetry__key">TILT</span><span className="mm-telemetry__value">{Math.round((view.pitch * 180) / Math.PI)}°</span></span>
      <span className="mm-telemetry__item mm-scale" aria-label={`Scale ${scale.label}`}>
        <span className="mm-telemetry__value" style={{ fontSize: 10 }}>{scale.label}</span>
        <span className="mm-scale__bar" style={{ width: Math.round(scale.px) }} />
      </span>
      <span className="mm-telemetry__item mm-telemetry__desktop"><span className="mm-telemetry__key">TILES</span><span className="mm-telemetry__value">{tiles}</span></span>
      <span className="mm-telemetry__spacer" />
      <span className="mm-telemetry__credits mm-telemetry__desktop">
        © <a href="https://geoservices.ign.fr/bdtopo" target="_blank" rel="noreferrer">IGN BD TOPO</a> · <a href="https://adresse.data.gouv.fr" target="_blank" rel="noreferrer">BAN</a> · <a href="https://annuaire-entreprises.data.gouv.fr" target="_blank" rel="noreferrer">INSEE SIRENE</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>{datasetDate === null ? "" : ` · data ${datasetDate}`}
      </span>
      <span className="mm-telemetry__item"><span className="mm-telemetry__value">{date} {time}</span></span>
    </div>
  );
}

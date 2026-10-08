"use client";

import { useEffect, useState } from "react";

export type BootStatus = "wait" | "ok" | "fail";

export interface BootStep {
  label: string;
  status: BootStatus;
  detail?: string;
}

export interface BootSequenceProps {
  steps: readonly BootStep[];
  /** True once the map can be shown; the sequence then fades out. */
  ready: boolean;
}

const MIN_VISIBLE_MS = 1100;

/**
 * The Machine coming online: real loading steps typed out as system lines,
 * then a fade into the map. It never holds the map back longer than the
 * data does, beyond a short minimum so the sequence can be read.
 */
export default function BootSequence({ steps, ready }: BootSequenceProps) {
  const [started] = useState(() => Date.now());
  const [done, setDone] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (!ready) return;
    const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - started));
    const fade = window.setTimeout(() => setDone(true), wait);
    const remove = window.setTimeout(() => setGone(true), wait + 700);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(remove);
    };
  }, [ready, started]);

  if (gone) return null;
  const completed = steps.filter((step) => step.status === "ok").length;
  const progress = steps.length === 0 ? 0 : completed / steps.length;
  return (
    <div className="mm-boot" data-done={done} data-testid="map-loading" role="status" aria-live="polite" aria-label="Loading the map">
      <div className="mm-boot__frame mm-brackets">
        <div className="mm-tag mm-tag--yellow">Territory 32 // Gers // Occitanie</div>
        <div className="mm-boot__brand">MASTER<span>·</span>MAPS</div>
        <div className="mm-boot__lines">
          <div className="mm-boot__line">
            <span>INITIALIZING SURVEILLANCE GRID</span>
            <span className="mm-boot__ok">OK</span>
          </div>
          {steps.map((step) => (
            <div className="mm-boot__line" key={step.label}>
              <span className={step.status === "wait" ? "mm-caret" : undefined}>{step.label}{step.detail ? ` // ${step.detail}` : ""}</span>
              <span className={step.status === "ok" ? "mm-boot__ok" : step.status === "fail" ? "mm-boot__fail" : "mm-boot__wait"}>
                {step.status === "ok" ? "OK" : step.status === "fail" ? "FAIL" : "…"}
              </span>
            </div>
          ))}
        </div>
        <div className="mm-boot__bar"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
      </div>
    </div>
  );
}

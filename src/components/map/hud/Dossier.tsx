"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export interface DossierField {
  label: string;
  value: ReactNode;
}

export interface DossierSection {
  title: string;
  fields: DossierField[];
}

export interface DossierData {
  key: string;
  code: string;
  tone: "yellow" | "white" | "red" | "ghost";
  title: string;
  subtitle: string;
  open: { open: boolean; detail: string } | null;
  sections: DossierSection[];
  hours: { day: string; text: string; today: boolean }[] | null;
  phone?: string;
  website?: string;
  osmUrl?: string;
  sources: string[];
}

export interface DossierProps {
  data: DossierData;
  loading: boolean;
  onClose: () => void;
  onCenter: () => void;
  onCopyCoordinates: () => void;
  onShare: () => void;
}

/**
 * The subject file: everything known about the selected place, laid out as a
 * Machine dossier. Fields type in as they arrive; Escape closes it.
 */
export default function Dossier({ data, loading, onClose, onCenter, onCopyCoordinates, onShare }: DossierProps) {
  const [collapsed, setCollapsed] = useState(false);
  /* A new subject always opens expanded (state reset during render, not in an effect). */
  const [shownKey, setShownKey] = useState(data.key);
  if (shownKey !== data.key) {
    setShownKey(data.key);
    setCollapsed(false);
  }
  const closeRef = useRef<HTMLButtonElement | null>(null);

  /* One listener for the dossier's lifetime: a listener re-subscribed because an earlier
     handler of the same key press re-rendered the map would miss that press. */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside className="mm-dossier mm-panel mm-brackets" aria-label={`Details: ${data.title}`} data-collapsed={collapsed} data-testid="feature-dossier">
      <header className="mm-dossier__head" onClick={() => { if (window.matchMedia("(max-width: 720px)").matches) setCollapsed((value) => !value); }}>
        <div className="mm-dossier__topline">
          <span className="mm-tag">
            <span className={`mm-chip-code${data.tone === "yellow" ? "" : ` mm-chip-code--${data.tone}`}`}>{data.code}</span>
            Subject file
          </span>
          <button ref={closeRef} type="button" className="mm-close" aria-label="Close details" onClick={(event) => { event.stopPropagation(); onClose(); }}>
            <Icon name="close" width={14} height={14} />
          </button>
        </div>
        <h2 className="mm-dossier__title">{data.title}</h2>
        {data.subtitle !== "" ? <p className="mm-dossier__subtitle">{data.subtitle}</p> : null}
        {data.open !== null ? (
          <p className="mm-dossier__status" style={{ color: data.open.open ? "var(--mm-green)" : "var(--mm-red)" }}>
            <span className="mm-dot" aria-hidden="true" />
            {data.open.open ? "Open now" : "Closed"} <span style={{ color: "var(--mm-ink-2)", letterSpacing: "0.04em", textTransform: "none" }}>· {data.open.detail}</span>
          </p>
        ) : null}
      </header>
      <div className="mm-dossier__actions">
        <button type="button" className="mm-action mm-action--primary" onClick={onCenter}><Icon name="target" />Center</button>
        <button type="button" className="mm-action" onClick={onShare}><Icon name="share" />Share</button>
        <button type="button" className="mm-action" onClick={onCopyCoordinates}><Icon name="copy" />Coordinates</button>
        {data.phone !== undefined ? <a className="mm-action" href={`tel:${data.phone.replace(/\s+/g, "")}`}><Icon name="phone" />Call</a> : null}
        {data.website !== undefined ? <a className="mm-action" href={data.website} target="_blank" rel="noreferrer noopener"><Icon name="globe" />Website</a> : null}
        {data.osmUrl !== undefined ? <a className="mm-action" href={data.osmUrl} target="_blank" rel="noreferrer noopener"><Icon name="external" />OSM</a> : null}
      </div>
      <div className="mm-dossier__body">
        {data.sections.map((section) => (
          <section className="mm-section" key={section.title}>
            <h3 className="mm-tag mm-section__title">{section.title}</h3>
            <dl className="mm-fields">
              {section.fields.map((field) => (
                <FieldRow key={`${data.key}:${section.title}:${field.label}`} field={field} />
              ))}
            </dl>
          </section>
        ))}
        {data.hours !== null ? (
          <section className="mm-section">
            <h3 className="mm-tag mm-section__title">Opening hours</h3>
            <div className="mm-hours">
              {data.hours.map((row) => (
                <div key={row.day} style={{ display: "contents" }} className={row.today ? "mm-hours__today" : undefined}>
                  <span className={row.today ? "mm-hours__today" : undefined}>{row.day}</span>
                  <span className={row.today ? "mm-hours__today" : undefined}>{row.text}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {loading ? <p className="mm-tag mm-caret" style={{ marginTop: 14 }}>Retrieving records</p> : null}
      </div>
      {data.sources.length > 0 ? <footer className="mm-dossier__foot">Sources: {data.sources.join(" · ")}</footer> : null}
    </aside>
  );
}

function FieldRow({ field }: { field: DossierField }) {
  return (
    <>
      <dt>{field.label}</dt>
      <dd>{field.value}</dd>
    </>
  );
}

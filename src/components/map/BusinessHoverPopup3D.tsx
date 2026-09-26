"use client";

import { Html } from "@react-three/drei";

export interface BusinessHoverPopupBusiness {
  stableId: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  businessName?: string;
  name?: string;
  legalName?: string;
  brand?: string;
  category?: string;
  nafLabel?: string;
  address?: string;
  nafCode?: string;
  siret?: string;
  phone?: string;
  website?: string;
  openingHours?: string;
  operator?: string;
  wheelchair?: string;
}

export interface BusinessHoverPopup3DProps {
  business: BusinessHoverPopupBusiness;
}

interface PopupField {
  label: string;
  value: string;
}

export default function BusinessHoverPopup3D({ business }: BusinessHoverPopup3DProps) {
  const [x, z] = business.geometry.coordinates;
  const title = business.businessName ?? business.name ?? business.brand ?? business.legalName;
  if (!title) return null;

  const fields: PopupField[] = [
    { label: "Activité", value: business.category ?? business.nafLabel ?? "" },
    { label: "Code NAF", value: business.nafCode ?? "" },
    { label: "Adresse", value: business.address ?? "" },
    { label: "SIRET", value: business.siret ?? "" },
    { label: "Téléphone", value: business.phone ?? "" },
    { label: "Horaires", value: business.openingHours ?? "" },
    { label: "Opérateur", value: business.operator ?? "" },
    { label: "Accessibilité", value: business.wheelchair ?? "" },
  ].filter((field) => field.value.length > 0);

  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 2.5, 0]}>
        <cylinderGeometry args={[0.25, 0.25, 5, 8]} />
        <meshBasicMaterial color="#ff7d27" />
      </mesh>
      <Html
        position={[0, 5, 0]}
        transform
        sprite
        center
        distanceFactor={18}
        zIndexRange={[20, 0]}
        style={{ pointerEvents: "none" }}
      >
        <div
          data-testid="business-hover-popup"
          data-business-id={business.stableId}
          aria-label={`Informations sur ${title}`}
          style={{
            width: "190px",
            padding: "9px 11px",
            border: "1px solid color-mix(in srgb, var(--color-ink, #000) 24%, transparent)",
            borderRadius: "2px",
            background: "color-mix(in srgb, var(--color-paper, #fff) 96%, transparent)",
            color: "var(--color-ink, #000000)",
            boxShadow: "0 5px 18px color-mix(in srgb, var(--color-ink, #000) 22%, transparent)",
            fontFamily: "system-ui, sans-serif",
            fontSize: "11px",
            lineHeight: 1.35,
          }}
        >
          <strong style={{ display: "block", marginBottom: "5px", fontSize: "13px", color: "var(--color-ink, #000000)" }}>
            {title}
          </strong>
          {fields.map((field) => (
            <div key={field.label} style={{ display: "grid", gridTemplateColumns: "62px 1fr", gap: "4px" }}>
              <span style={{ color: "color-mix(in srgb, var(--color-ink, #000) 62%, transparent)" }}>{field.label}</span>
              <span style={{ overflowWrap: "anywhere" }}>{field.value}</span>
            </div>
          ))}
          {business.website && (
            <a
              href={business.website}
              target="_blank"
              rel="noreferrer"
              tabIndex={-1}
              style={{ display: "inline-block", marginTop: "5px", color: "var(--color-accent, #ff7d27)" }}
            >
              Site web
            </a>
          )}
        </div>
      </Html>
    </group>
  );
}

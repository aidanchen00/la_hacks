"use client";

import type { RoutingDecision } from "@/lib/api";

type CareKey = "telehealth" | "doctor" | "urgent_care" | "er" | "pharmacy";

interface CostRow {
  key: CareKey;
  label: string;
  /** Range for insured patients — null means single-tier pricing */
  insured: string | null;
  /** Range for uninsured patients */
  uninsured: string;
}

const COST_ROWS: CostRow[] = [
  { key: "telehealth",   label: "Telehealth visit",          insured: null,       uninsured: "$0–$75 typical"         },
  { key: "doctor",       label: "Doctor's office visit",     insured: "$25–$75",  uninsured: "$150–$300"              },
  { key: "urgent_care",  label: "Urgent care",               insured: "$30–$150", uninsured: "$150–$400"              },
  { key: "er",           label: "Emergency room",            insured: "$150–$500",uninsured: "$1,000–$3,000+"         },
  { key: "pharmacy",     label: "Pharmacy / OTC medication", insured: null,       uninsured: "$5–$30 typical"         },
];

// Map the AI's recommended_path values to the cost row that best represents that care type
const PATH_TO_KEY: Partial<Record<string, CareKey>> = {
  doctor:       "doctor",
  pharmacy:     "pharmacy",
  mental_health:"telehealth",
  alt_medicine: "telehealth",
  self_care:    "pharmacy",
};

interface Props {
  urgency: RoutingDecision["urgency"];
  recommendedPath: RoutingDecision["recommended_path"];
}

export default function CostTransparency({ urgency, recommendedPath }: Props) {
  // No cost context needed for pure wellness check-ins
  if (urgency === "wellness") return null;

  const highlightedKey: CareKey =
    urgency === "emergency" ? "er" : (PATH_TO_KEY[recommendedPath] ?? "doctor");

  // Highlighted row floats to the top
  const rows = [...COST_ROWS].sort((a, b) => {
    if (a.key === highlightedKey) return -1;
    if (b.key === highlightedKey) return 1;
    return 0;
  });

  return (
    <div
      className="card"
      style={{ marginBottom: 24 }}
      role="region"
      aria-label="Cost estimates"
    >
      {/* Header */}
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "var(--primary)" }}>
        What this might cost
      </h2>
      <p style={{ margin: "5px 0 20px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
        Estimates for the LA area. Costs vary by location and provider.
      </p>

      {/* Column headers — only on wider screens via min-width trick */}
      <div style={{
        display: "flex",
        justifyContent: "flex-end",
        gap: 8,
        paddingRight: 14,
        marginBottom: 4,
      }}>
        <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          With insurance · Without
        </span>
      </div>

      {/* Rows */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {rows.map((row, idx) => {
          const highlighted = row.key === highlightedKey;
          return (
            <div key={row.key}>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "8px 12px",
                padding: "11px 14px",
                borderRadius: 10,
                background: highlighted ? "var(--accent-dim)" : "transparent",
                transition: "background 0.15s",
              }}>
                {/* Label + badge */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{
                    fontSize: 14,
                    color: highlighted ? "var(--text)" : "var(--muted)",
                    fontWeight: highlighted ? 600 : 400,
                  }}>
                    {row.label}
                  </span>
                  {highlighted && (
                    <span style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: "var(--primary)",
                      background: "rgba(31,58,46,0.10)",
                      borderRadius: 9999,
                      padding: "2px 9px",
                      letterSpacing: "0.03em",
                      whiteSpace: "nowrap",
                    }}>
                      Recommended for you
                    </span>
                  )}
                </div>

                {/* Price */}
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  {row.insured === null ? (
                    <span style={{
                      fontSize: 15,
                      fontWeight: 700,
                      color: highlighted ? "var(--primary)" : "var(--muted)",
                    }}>
                      {row.uninsured}
                    </span>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
                      <span style={{
                        fontSize: 15,
                        fontWeight: 700,
                        color: highlighted ? "var(--primary)" : "var(--muted)",
                      }}>
                        {row.insured}
                        <span style={{ fontSize: 11, fontWeight: 400, color: "var(--muted)", marginLeft: 4 }}>insured</span>
                      </span>
                      <span style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: highlighted ? "var(--primary)" : "var(--muted)",
                      }}>
                        {row.uninsured}
                        <span style={{ fontSize: 11, fontWeight: 400, color: "#475569", marginLeft: 4 }}>without</span>
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {idx < rows.length - 1 && (
                <div style={{ height: 1, background: "var(--border)", margin: "0 14px" }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Financial assistance callout */}
      <div style={{
        marginTop: 20,
        padding: "14px 16px",
        background: "rgba(31,58,46,0.04)",
        border: "1px solid var(--border)",
        borderRadius: 10,
      }}>
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted)", lineHeight: 1.75 }}>
          <strong style={{ color: "var(--primary)", fontWeight: 600 }}>Worried about cost?</strong>{" "}
          Many California community clinics serve uninsured patients on a sliding-scale fee — what you pay depends on your income, not your insurance. Ask any provider about financial assistance programs. It&apos;s normal and you don&apos;t need documentation status to qualify in most cases.
        </p>
      </div>
    </div>
  );
}

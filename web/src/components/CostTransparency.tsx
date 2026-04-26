"use client";

import { useMemo } from "react";
import type { RoutingDecision } from "@/lib/api";
import { useTranslate } from "@/lib/translate";

type CareKey = "telehealth" | "doctor" | "urgent_care" | "er" | "pharmacy";

interface CostRow {
  key: CareKey;
  label: string;
  /** Range for insured patients — null means single-tier pricing */
  insured: string | null;
  /** Range for uninsured patients */
  uninsured: string;
}

// Ranges below reflect California metro averages (LA / Bay Area / SD)
// for 2024–2025. CA cash-pay and ER bills run noticeably higher than the
// national medians most national charts cite.
const COST_ROWS: CostRow[] = [
  { key: "telehealth",   label: "Telehealth visit",          insured: null,       uninsured: "$40–$95 typical"        },
  { key: "doctor",       label: "Doctor's office visit",     insured: "$25–$60",  uninsured: "$200–$450"              },
  { key: "urgent_care",  label: "Urgent care",               insured: "$50–$150", uninsured: "$200–$500"              },
  { key: "er",           label: "Emergency room",            insured: "$250–$700",uninsured: "$1,500–$5,000+"         },
  { key: "pharmacy",     label: "Pharmacy / OTC medication", insured: null,       uninsured: "$8–$45 typical"         },
];

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
  // Hooks must run unconditionally — bail to null AFTER computing translations.
  const STATIC_KEYS = useMemo(() => [
    "What this might cost",                                                                            // 0
    "Estimates for the LA area. Costs vary by location and provider.",                                 // 1
    "With insurance · Without",                                                                        // 2
    "Recommended for you",                                                                             // 3
    "insured",                                                                                         // 4
    "without",                                                                                         // 5
    "Worried about cost?",                                                                             // 6
    "Many California community clinics serve uninsured patients on a sliding-scale fee — what you pay depends on your income, not your insurance. Ask any provider about financial assistance programs. It's normal and you don't need documentation status to qualify in most cases.", // 7
    "Telehealth visit",                                                                                // 8
    "Doctor's office visit",                                                                           // 9
    "Urgent care",                                                                                     // 10
    "Emergency room",                                                                                  // 11
    "Pharmacy / OTC medication",                                                                       // 12
    "$40–$95 typical",                                                                                 // 13
    "$8–$45 typical",                                                                                  // 14
  ], []);
  const t = useTranslate(STATIC_KEYS);
  const labelByKey: Record<CareKey, string> = {
    telehealth:  t[8],
    doctor:      t[9],
    urgent_care: t[10],
    er:          t[11],
    pharmacy:    t[12],
  };
  const uninsuredOverride: Partial<Record<CareKey, string>> = {
    telehealth: t[13],
    pharmacy:   t[14],
  };

  if (urgency === "wellness") return null;

  const highlightedKey: CareKey =
    urgency === "emergency" ? "er" : (PATH_TO_KEY[recommendedPath] ?? "doctor");

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
      <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "var(--primary)" }}>
        {t[0]}
      </h2>
      <p style={{ margin: "5px 0 20px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
        {t[1]}
      </p>

      <div style={{
        display: "flex",
        justifyContent: "flex-end",
        gap: 8,
        paddingRight: 14,
        marginBottom: 4,
      }}>
        <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          {t[2]}
        </span>
      </div>

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
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{
                    fontSize: 14,
                    color: highlighted ? "var(--text)" : "var(--muted)",
                    fontWeight: highlighted ? 600 : 400,
                  }}>
                    {labelByKey[row.key]}
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
                      {t[3]}
                    </span>
                  )}
                </div>

                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  {row.insured === null ? (
                    <span style={{
                      fontSize: 15,
                      fontWeight: 700,
                      color: highlighted ? "var(--primary)" : "var(--muted)",
                    }}>
                      {uninsuredOverride[row.key] ?? row.uninsured}
                    </span>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
                      <span style={{
                        fontSize: 15,
                        fontWeight: 700,
                        color: highlighted ? "var(--primary)" : "var(--muted)",
                      }}>
                        {row.insured}
                        <span style={{ fontSize: 11, fontWeight: 400, color: "var(--muted)", marginLeft: 4 }}>{t[4]}</span>
                      </span>
                      <span style={{
                        fontSize: 13,
                        fontWeight: 600,
                        color: highlighted ? "var(--primary)" : "var(--muted)",
                      }}>
                        {row.uninsured}
                        <span style={{ fontSize: 11, fontWeight: 400, color: "#475569", marginLeft: 4 }}>{t[5]}</span>
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

      <div style={{
        marginTop: 20,
        padding: "14px 16px",
        background: "rgba(31,58,46,0.04)",
        border: "1px solid var(--border)",
        borderRadius: 10,
      }}>
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted)", lineHeight: 1.75 }}>
          <strong style={{ color: "var(--primary)", fontWeight: 600 }}>{t[6]}</strong>{" "}
          {t[7]}
        </p>
      </div>
    </div>
  );
}

/**
 * Demo fixtures — used when live APIs are unavailable so the demo never blanks out.
 */

export const FIXTURE_ROUTING_DECISION = {
  run_id: "demo-run-001",
  urgency: "routine" as const,
  recommended_path: "doctor" as const,
  summary:
    "You mentioned a sore throat and low-grade fever lasting 3 days. These symptoms could indicate a bacterial or viral upper respiratory infection. A primary care visit is recommended to rule out strep throat.",
  next_actions: [
    "Schedule an appointment with a primary care physician within 1-2 days",
    "Stay hydrated and rest",
    "Monitor temperature — if it rises above 103°F, seek urgent care",
    "Avoid contact with others to prevent spreading potential infection",
  ],
  payment_required: false,
  payment_amount_usd: 0,
  requires_doctor_approval: false,
  rationale: "Persistent fever >3 days + sore throat warrants in-person evaluation for strep/mono.",
  disclaimers: [
    "Prana is a wellness education tool, not a medical diagnosis service.",
    "Always consult a licensed healthcare professional for medical advice.",
  ],
};

export const FIXTURE_DOCTOR_SESSIONS = [
  { agent: "ZocDoc", sessionId: "mock-zocdoc", liveUrl: "", status: "running" },
  { agent: "Healthgrades", sessionId: "mock-healthgrades", liveUrl: "", status: "running" },
  { agent: "Solv", sessionId: "mock-solv", liveUrl: "", status: "running" },
];

export const FIXTURE_ALT_MEDICINE = {
  TCM: { lat: 39.9042, lng: 116.4074, zoom: 4 },
  Ayurveda: { lat: 20.5937, lng: 78.9629, zoom: 4 },
  Kampo: { lat: 35.6895, lng: 139.6917, zoom: 5 },
  Naturopathy: { lat: 40.015, lng: -105.2705, zoom: 4 },
};

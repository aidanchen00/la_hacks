async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = typeof window !== "undefined" ? "" : `http://localhost:${process.env.PORT ?? 3000}`;
  const res = await fetch(`${base}/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json();
}

export interface IntakePayload {
  transcript: string;
  summary: string;
  voice_session_id?: string;
  user_email?: string;
  nullifier_hash?: string;
}

export interface RunStatus {
  id: string;
  status: string;
  intake_summary: string | null;
  routing_decision: RoutingDecision | null;
  events_count: number;
}

export interface Citation {
  condition: string;
  source: "Mayo Clinic" | "Healthline" | "Cleveland Clinic" | "NIH";
  url: string;
}

export interface RoutingDecision {
  run_id: string;
  urgency: "emergency" | "urgent" | "routine" | "wellness";
  recommended_path: "doctor" | "pharmacy" | "mental_health" | "alt_medicine" | "self_care";
  summary: string;
  next_actions: string[];
  payment_required: boolean;
  payment_amount_usd: number;
  requires_doctor_approval: boolean;
  rationale: string;
  disclaimers: string[];
  citations: Citation[];
}

export function postIntake(payload: IntakePayload): Promise<{ run_id: string }> {
  return request("/intake", { method: "POST", body: JSON.stringify(payload) });
}

export function getRun(runId: string): Promise<RunStatus> {
  return request(`/runs/${runId}`);
}

export interface RunSummary {
  id: string;
  status: string;
  instruction: string | null;
  intake_summary: string | null;
  created_at: string;
  urgency: string | null;
  recommended_path: string | null;
  rd_summary: string | null;
}

export function listRuns(): Promise<RunSummary[]> {
  return request("/runs", { cache: "no-store" });
}

export function getSSEUrl(runId: string): string {
  return `/api/runs/${runId}/events`;
}

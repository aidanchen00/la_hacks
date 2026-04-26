const BACKEND = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND}${path}`, {
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
}

export interface RunStatus {
  id: string;
  status: string;
  intake_summary: string | null;
  routing_decision: RoutingDecision | null;
  events_count: number;
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
  // Per-session search context produced by the router LLM
  specialty?: string | null;
  location?: string | null;
  search_query?: string | null;
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
  return fetch("/api/runs").then((r) => {
    if (!r.ok) throw new Error(`/api/runs → ${r.status}`);
    return r.json();
  });
}

export function getSSEUrl(runId: string): string {
  return `${BACKEND}/runs/${runId}/events`;
}

export interface CartItem {
  id: number;
  run_id: string;
  agent_name: string;
  platform: string;
  item_name: string | null;
  item_price: number;
  item_url: string | null;
  item_description: string | null;
  in_stock: number;
  created_at: string;
}

export interface BudgetSession {
  run_id: string;
  total_budget_usd: number;
  per_agent_usd: number;
  num_agents: number;
  status: string;
  stripe_session_id?: string | null;
  checkout_url?: string | null;
}

export interface BudgetWallet {
  run_id: string;
  agent_name: string;
  allocated_usd: number;
  balance_usd: number;
  status: string;
}

export interface BudgetStatus {
  session: BudgetSession;
  wallets: BudgetWallet[];
  cart: CartItem[];
}

export function getBudget(runId: string): Promise<BudgetStatus> {
  return request(`/budget/${runId}`);
}

export interface CheckoutItem {
  name: string;
  platform: string;
  price: number;
}

export function createBudgetCheckout(runId: string, items: CheckoutItem[]): Promise<{ checkout_url: string; session_id: string }> {
  return request("/budget/checkout", {
    method: "POST",
    body: JSON.stringify({ run_id: runId, items }),
  });
}

// ---------------------------------------------------------------------------
// Ranker
// ---------------------------------------------------------------------------

export interface RankerCandidate {
  source_agent: string;
  name: string;
  price?: number;
  url?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RankerSelectionItem {
  id?: number;
  run_id?: string;
  domain: string;
  source_agent: string;
  name: string;
  price: number;
  url: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  score: number;
  rationale: string;
  selected: boolean;
  booked?: boolean;
  stripe_session_id?: string | null;
}

export interface RankerStatus {
  run_id: string;
  domain: string | null;
  items: RankerSelectionItem[];
  selected: RankerSelectionItem[];
  selected_total_usd: number;
}

export interface RankRequestBody {
  domain: "pharmacy" | "doctor";
  query: string;
  intake_summary?: string;
  urgency?: string;
  requires_doctor_approval?: boolean;
  total_budget_usd?: number;
  per_agent_budget_usd?: number;
  candidates: RankerCandidate[];
}

export function runRanker(runId: string, body: RankRequestBody): Promise<unknown> {
  return request(`/rank/${runId}`, { method: "POST", body: JSON.stringify(body) });
}

export function getRanker(runId: string, domain: "pharmacy" | "doctor"): Promise<RankerStatus> {
  return request(`/rank/${runId}?domain=${domain}`);
}

export interface DoctorCheckoutItem {
  id?: number;
  name: string;
  price: number;
  source_agent?: string;
  description?: string | null;
}

export function createDoctorCheckout(runId: string, items: DoctorCheckoutItem[]): Promise<{ checkout_url: string; session_id: string }> {
  return request("/doctor/checkout", {
    method: "POST",
    body: JSON.stringify({ run_id: runId, items }),
  });
}

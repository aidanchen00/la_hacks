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
  nullifier_hash?: string;
}

export interface RunStatus {
  id: string;
  status: string;
  intake_summary: string | null;
  routing_decision: RoutingDecision | null;
  events_count: number;
  created_at?: string;
  video_analysis?: string | null;
  twelve_labs_video_id?: string | null;
  expert_route?: "doctor" | "alternative_medicine" | "emergency" | null;
  expert_rationale?: string | null;
}

export interface Citation {
  condition: string;
  source: string;
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
  citations?: Citation[];
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
  has_video?: number | boolean;
  expert_route?: "doctor" | "alternative_medicine" | "emergency" | null;
}

export function postIntakeVideo(
  runId: string,
  blob: Blob,
): Promise<{ ok: boolean; run_id: string; status: string }> {
  const fd = new FormData();
  fd.append("run_id", runId);
  // Filename hint for the backend; extension is informational only.
  const ext = blob.type.includes("webm") ? "webm" : "mp4";
  fd.append("video", blob, `${runId}.${ext}`);
  return fetch(`${BACKEND}/intake/video`, { method: "POST", body: fd }).then(async (r) => {
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`/intake/video → ${r.status} ${txt}`);
    }
    return r.json();
  });
}

export function listRuns(): Promise<RunSummary[]> {
  return fetch("/api/runs", { cache: "no-store" }).then((r) => {
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
  id?: number;
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

// ---------------------------------------------------------------------------
// Profile (anonymous, keyed on World ID nullifier hash)
// ---------------------------------------------------------------------------

export interface UserProfile {
  nullifier_hash: string;
  display_name: string | null;
  age: number | null;
  sex: string | null;
  gender: string | null;
  weight_lbs: number | null;
  height_in: number | null;
  allergies: string;
  conditions: string;
  medications: string;
  insurance_provider: string | null;
  insurance_member_id: string | null;
  insurance_group_id: string | null;
  deductible_total_usd: number;
  deductible_used_usd: number;
  plan_year_start: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeductiblePayment {
  id: number;
  nullifier_hash: string;
  run_id: string | null;
  amount_usd: number;
  source: string | null;          // 'doctor' | 'pharmacy' | ...
  stripe_session_id: string | null;
  created_at: string;
}

export interface ProfileResponse {
  nullifier_hash: string;
  profile: UserProfile | null;
  deductible_history: DeductiblePayment[];
}

export type ProfileEditableFields = Partial<Pick<UserProfile,
  | "display_name" | "age" | "sex" | "gender" | "weight_lbs" | "height_in"
  | "allergies" | "conditions" | "medications"
  | "insurance_provider" | "insurance_member_id" | "insurance_group_id"
  | "deductible_total_usd" | "plan_year_start"
>>;

export function getProfile(nullifierHash: string): Promise<ProfileResponse> {
  return request(`/profile/${encodeURIComponent(nullifierHash)}`);
}

export function updateProfile(nullifierHash: string, fields: ProfileEditableFields): Promise<{ nullifier_hash: string; profile: UserProfile }> {
  return request(`/profile/${encodeURIComponent(nullifierHash)}`, {
    method: "PUT",
    body: JSON.stringify(fields),
  });
}

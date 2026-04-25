import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

const RANKER_URL = process.env.RANKER_AGENT_URL ?? "http://localhost:8107";

/**
 * Proxies ranking requests to the Fetch.ai ranker agent's REST endpoint.
 *
 * Body shape (matches RankRequest in agents/shared/messages.py):
 * {
 *   run_id, domain: "pharmacy" | "doctor", query, intake_summary, urgency,
 *   requires_doctor_approval, total_budget_usd, per_agent_budget_usd,
 *   candidates: [{ source_agent, name, price, url?, description?, metadata? }]
 * }
 */
export async function POST(req: NextRequest) {
  const body = await req.json();

  // Defaults so the ranker doesn't reject malformed payloads
  const payload = {
    run_id: body.run_id ?? "",
    domain: body.domain ?? "pharmacy",
    query: body.query ?? "",
    intake_summary: body.intake_summary ?? "",
    urgency: body.urgency ?? "wellness",
    requires_doctor_approval: !!body.requires_doctor_approval,
    total_budget_usd: Number(body.total_budget_usd ?? 0),
    per_agent_budget_usd: Number(body.per_agent_budget_usd ?? 0),
    candidates: Array.isArray(body.candidates) ? body.candidates : [],
    requester_address: null,
  };

  if (payload.candidates.length === 0) {
    return NextResponse.json({ error: "no candidates to rank" }, { status: 400 });
  }

  try {
    const res = await fetch(`${RANKER_URL}/rank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json({ error: `ranker returned ${res.status}: ${text}` }, { status: 502 });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "ranker unreachable — is the agent bureau running?" },
      { status: 502 },
    );
  }
}

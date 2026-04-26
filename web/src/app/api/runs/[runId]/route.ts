import { NextResponse } from "next/server";
import { getRun, getRoutingDecision } from "@/lib/db";

export const revalidate = 0;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    const { runId } = await params;
    const run = getRun(runId);
    if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

    const rd = getRoutingDecision(runId);

    return NextResponse.json({
      id: run.id,
      status: run.status,
      intake_summary: run.intake_summary,
      routing_decision: rd
        ? {
            run_id: rd.run_id,
            urgency: rd.urgency,
            recommended_path: rd.recommended_path,
            summary: rd.summary,
            next_actions: JSON.parse(rd.next_actions || "[]"),
            payment_required: Boolean(rd.payment_required),
            payment_amount_usd: rd.payment_amount,
            requires_doctor_approval: Boolean(rd.requires_doctor_approval),
            rationale: rd.rationale,
            disclaimers: JSON.parse(rd.disclaimers || "[]"),
            citations: JSON.parse(rd.citations || "[]"),
          }
        : null,
      events_count: 0,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

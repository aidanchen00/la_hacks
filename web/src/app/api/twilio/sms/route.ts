import { NextRequest, NextResponse } from "next/server";
import twilio from "twilio";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const { summary, symptoms, urgency, suggested_path, run_id } =
    (await req.json()) as {
      summary?: string;
      symptoms?: string;
      urgency?: string;
      suggested_path?: string;
      run_id?: string;
    };

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const to = process.env.TWILIO_TO_NUMBER;

  if (!accountSid || !authToken || !from || !to) {
    return NextResponse.json({ sent: false, error: "Twilio not configured" }, { status: 500 });
  }

  const urgencyLine = urgency ? `Urgency: ${urgency.toUpperCase()}` : "";
  const pathLine = suggested_path ? `Path: ${suggested_path.replace("_", " ")}` : "";
  const symptomsLine = symptoms ? `Concerns: ${symptoms}` : "";
  const summaryLine = summary ?? "Intake recorded — check your dashboard for details.";
  const dashboardLine = run_id ? `Dashboard: http://localhost:3000/dashboard?run_id=${run_id}` : "";

  const body = [
    "🩺 Prana Intake Complete",
    urgencyLine,
    pathLine,
    "",
    summaryLine,
    "",
    symptomsLine,
    dashboardLine,
    "",
    "Not medical advice. Call 911 for emergencies.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const client = twilio(accountSid, authToken);
    await client.messages.create({ from, to, body });
    return NextResponse.json({ sent: true, to });
  } catch (e) {
    return NextResponse.json({ sent: false, error: (e as Error).message }, { status: 500 });
  }
}

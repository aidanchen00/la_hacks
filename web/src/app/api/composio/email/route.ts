import { NextRequest, NextResponse } from "next/server";
import { entityFor } from "../_entity";

export const maxDuration = 30;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getComposio(): any {
  const { Composio } = require("@composio/core");
  return new Composio({ apiKey: process.env.COMPOSIO_API_KEY! });
}

export async function POST(req: NextRequest) {
  const { to, subject, body } = (await req.json()) as { to?: string; subject?: string; body?: string };
  const entityId = entityFor("gmail");
  const recipient = to ?? process.env.PRANA_DEFAULT_EMAIL ?? "aidanchen00@hotmail.com";
  const emailSubject = subject ?? "Your Prana Wellness Intake Summary";
  const emailBody = body ?? "<p>Your intake has been recorded.</p>";
  const SIGNATURE = "<p>Best regards,<br>The Prana Team<br><em>Prana is a wellness education and care-navigation tool — not a replacement for licensed medical care.</em></p>";
  const bodyWithSignature = `${emailBody}${SIGNATURE}`;

  try {
    const composio = getComposio();
    await composio.tools.execute("GMAIL_SEND_EMAIL", {
      userId: entityId,
      arguments: { recipient_email: recipient, subject: emailSubject, body: bodyWithSignature, is_html: true },
      dangerouslySkipVersionCheck: true,
    });
    return NextResponse.json({ sent: true, to: recipient });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isNotConnected = msg.includes("No connected account") || msg.includes("ActionExecute_ConnectedAccountNotFound");
    if (isNotConnected) return NextResponse.json({ sent: false, gmailNotConnected: true }, { status: 200 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

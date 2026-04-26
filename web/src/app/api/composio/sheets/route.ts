import { NextRequest, NextResponse } from "next/server";
import { entityFor } from "../_entity";

export const maxDuration = 30;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getComposio(): any {
  const { Composio } = require("@composio/core");
  return new Composio({ apiKey: process.env.COMPOSIO_API_KEY! });
}

export async function POST(req: NextRequest) {
  const row = (await req.json()) as Record<string, string>;
  const entityId = entityFor("sheets");
  // Prefer the new PRANA_SHEETS_ID; fall back to the legacy DOMUS_SHEETS_ID.
  const sheetsId = process.env.PRANA_SHEETS_ID ?? process.env.DOMUS_SHEETS_ID ?? "";

  if (!sheetsId) return NextResponse.json({ saved: false, error: "PRANA_SHEETS_ID (or legacy DOMUS_SHEETS_ID) not set" });

  const values = [
    row.run_id ?? "", row.timestamp ?? new Date().toISOString(), row.user_email ?? "",
    row.transcript ?? "", row.summary ?? "", row.symptoms ?? "",
    row.urgency ?? "", row.recommended_path ?? "", row.next_actions ?? "", row.disclaimers ?? "",
  ];

  try {
    const composio = getComposio();
    await composio.tools.execute("GOOGLESHEETS_BATCH_UPDATE", {
      userId: entityId,
      arguments: {
        spreadsheet_id: sheetsId,
        ranges: ["Sheet1!A:J"],
        value_input_option: "USER_ENTERED",
        data: [{ range: "Sheet1!A:J", values: [values] }],
      },
      dangerouslySkipVersionCheck: true,
    });
    return NextResponse.json({ saved: true });
  } catch (err) {
    return NextResponse.json({ saved: false, error: err instanceof Error ? err.message : String(err) });
  }
}

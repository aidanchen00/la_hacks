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
  const sheetsId = process.env.PRANA_SHEETS_ID ?? "";

  if (!sheetsId) return NextResponse.json({ saved: false, error: "PRANA_SHEETS_ID not set" });

  // Column order MUST match the spreadsheet's header row exactly:
  // A: run_id | B: timestamp | C: user_email | D: summary | E: symptoms |
  // F: urgency | G: recommended_path | H: next_actions | I: disclaimers
  const values = [
    row.run_id ?? "",
    row.timestamp ?? new Date().toISOString(),
    row.user_email ?? "",
    row.summary ?? "",
    row.symptoms ?? "",
    row.urgency ?? "",
    row.recommended_path ?? "",
    row.next_actions ?? "",
    row.disclaimers ?? "",
  ];

  try {
    const composio = getComposio();
    // Append a new row at the bottom of the sheet rather than overwriting A1:J1.
    // GOOGLESHEETS_VALUES_APPEND wraps Google's spreadsheets.values.append which
    // auto-finds the next blank row in the table starting at the given range.
    const result = await composio.tools.execute("GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND", {
      userId: entityId,
      arguments: {
        spreadsheet_id: sheetsId,
        range: "Sheet1!A:I",
        value_input_option: "USER_ENTERED",
        insert_data_option: "INSERT_ROWS",
        values: [values],
      },
      dangerouslySkipVersionCheck: true,
    });

    // Surface Composio's actual response so silent failures aren't hidden.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = result as any;
    if (r?.successful === false || r?.error) {
      return NextResponse.json({
        saved: false,
        error: r.error ?? r.message ?? "Composio reported failure",
        composio: r,
      }, { status: 500 });
    }

    return NextResponse.json({
      saved: true,
      updates: r?.data?.updates ?? null,
    });
  } catch (err) {
    return NextResponse.json({
      saved: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}

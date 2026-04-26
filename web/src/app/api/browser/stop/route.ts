import { NextRequest, NextResponse } from "next/server";
import { BrowserUse } from "browser-use-sdk/v3";

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const { sessionIds } = (await request.json()) as { sessionIds?: string[] };
  if (!sessionIds?.length) return NextResponse.json({ stopped: 0 });

  const client = new BrowserUse({ apiKey: process.env.BROWSER_USE_API_KEY! });
  const outcomes = await Promise.allSettled(
    sessionIds.map((id) => id?.trim() && client.sessions.stop(id, { strategy: "session" }))
  );
  return NextResponse.json({ stopped: sessionIds.filter(Boolean).length, failed: outcomes.filter((o) => o.status === "rejected").length });
}

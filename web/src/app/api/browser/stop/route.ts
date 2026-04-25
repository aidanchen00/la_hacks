import { NextRequest, NextResponse } from "next/server";
import { BrowserUse } from "browser-use-sdk/v3";

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const { sessionIds } = (await request.json()) as { sessionIds?: string[] };
  if (!sessionIds?.length) return NextResponse.json({ stopped: 0 });

  if (process.env.BROWSER_BACKEND === "steel") {
    const fastapiBase = process.env.FASTAPI_BASE_URL ?? "http://localhost:8000";
    try {
      const r = await fetch(`${fastapiBase}/browser-local/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionIds }),
      });
      if (r.ok) return NextResponse.json(await r.json());
    } catch { /* fall through */ }
    return NextResponse.json({ stopped: 0, failed: sessionIds.length, error: "Steel backend unreachable" });
  }

  const client = new BrowserUse({ apiKey: process.env.BROWSER_USE_API_KEY! });
  const outcomes = await Promise.allSettled(
    sessionIds.map((id) => id?.trim() && client.sessions.stop(id, { strategy: "session" }))
  );
  return NextResponse.json({ stopped: sessionIds.filter(Boolean).length, failed: outcomes.filter((o) => o.status === "rejected").length });
}

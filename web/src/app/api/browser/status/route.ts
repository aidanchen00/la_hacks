import { NextRequest, NextResponse } from "next/server";
import { BrowserUse } from "browser-use-sdk/v3";

export const maxDuration = 15;

export async function POST(request: NextRequest) {
  const { sessionIds } = (await request.json()) as { sessionIds: { agent: string; sessionId: string }[] };

  if (!sessionIds?.length) {
    return NextResponse.json({ error: "sessionIds required" }, { status: 400 });
  }

  const client = new BrowserUse({ apiKey: process.env.BROWSER_USE_API_KEY });

  const statuses = await Promise.all(
    sessionIds.map(async ({ agent, sessionId }) => {
      try {
        const session = await client.sessions.get(sessionId);
        const isTerminal = ["idle", "stopped", "error", "timed_out"].includes(session.status as string);
        let output = isTerminal ? session.output : null;
        if (output && typeof output === "object") output = JSON.stringify(output);
        return { agent, sessionId, status: session.status, output, done: isTerminal };
      } catch (err) {
        return { agent, sessionId, status: "error", output: null, done: true, error: err instanceof Error ? err.message : "Unknown error" };
      }
    })
  );

  return NextResponse.json({ sessions: statuses });
}

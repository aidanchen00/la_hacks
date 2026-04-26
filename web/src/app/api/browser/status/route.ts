import { NextRequest, NextResponse } from "next/server";
import { BrowserUse } from "browser-use-sdk/v3";

export const maxDuration = 15;

export async function POST(request: NextRequest) {
  const { sessionIds } = (await request.json()) as { sessionIds: { agent: string; sessionId: string }[] };

  if (!sessionIds?.length) {
    return NextResponse.json({ error: "sessionIds required" }, { status: 400 });
  }

  const client = new BrowserUse({ apiKey: process.env.BROWSER_USE_API_KEY });

  // BuAgentSessionStatus = "created" | "idle" | "running" | "stopped" | "timed_out" | "error"
  // "idle" is NOT terminal — the agent is just paused between actions; output isn't ready yet.
  // Treat the session as done only when (a) the SDK reports a real terminal state, or
  // (b) output is already populated (some completions land before the status flips).
  const TERMINAL = new Set(["stopped", "timed_out", "error", "finished", "completed"]);

  const statuses = await Promise.all(
    sessionIds.map(async ({ agent, sessionId }) => {
      // Mock sessions never hit BrowserUse — pretend they're already complete
      if (sessionId.startsWith("mock_")) {
        return { agent, sessionId, status: "completed", output: null, done: true, mock: true };
      }
      try {
        const session = await client.sessions.get(sessionId);
        const status = session.status as string;
        const hasOutput = session.output != null && session.output !== "";
        const isTerminal = TERMINAL.has(status) || hasOutput;
        let output: unknown = isTerminal ? session.output : null;
        if (output && typeof output === "object") output = JSON.stringify(output);
        return { agent, sessionId, status, output, done: isTerminal };
      } catch (err) {
        return { agent, sessionId, status: "error", output: null, done: true, error: err instanceof Error ? err.message : "Unknown error" };
      }
    })
  );

  // Free up concurrent slots immediately for any session that just reached a
  // terminal state — don't wait for the user to navigate away. Fire-and-forget,
  // and only kill sessions that are still in non-stopped states (BrowserUse
  // throws if you try to stop an already-stopped session).
  Promise.allSettled(
    statuses
      .filter((s) => s.done && s.sessionId && s.status !== "stopped" && s.status !== "error")
      .map((s) => client.sessions.stop(s.sessionId, { strategy: "session" }))
  ).catch(() => { /* best-effort */ });

  return NextResponse.json({ sessions: statuses });
}

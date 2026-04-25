import { NextResponse } from "next/server";
import { getRecentRuns } from "@/lib/db";

export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
    const runs = getRecentRuns(limit);
    return NextResponse.json(runs);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "DB error" }, { status: 500 });
  }
}

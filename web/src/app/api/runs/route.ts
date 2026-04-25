import { NextResponse } from "next/server";
import { getRecentRuns } from "@/lib/db";

export const revalidate = 0;

export async function GET() {
  try {
    const runs = getRecentRuns(20);
    return NextResponse.json(runs);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "DB error" }, { status: 500 });
  }
}

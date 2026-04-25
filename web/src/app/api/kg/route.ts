import { NextResponse } from "next/server";
import { buildKGData } from "@/lib/db";

export const revalidate = 0;

export async function GET() {
  try {
    const data = buildKGData();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "DB error" }, { status: 500 });
  }
}

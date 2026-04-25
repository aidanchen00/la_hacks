import { NextRequest, NextResponse } from "next/server";
import { Odyssey, credentialsToDict } from "@odysseyml/odyssey";

export const maxDuration = 30;

export async function POST(_req: NextRequest) {
  if (!process.env.ODYSSEY_API_KEY) {
    return NextResponse.json({ error: "ODYSSEY_API_KEY not configured" }, { status: 500 });
  }

  try {
    const client = new Odyssey({ apiKey: process.env.ODYSSEY_API_KEY });
    const credentials = await client.createClientCredentials();
    return NextResponse.json({ credentials: credentialsToDict(credentials) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

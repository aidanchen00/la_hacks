import { NextResponse } from "next/server";
import type { IDKitResult } from "@worldcoin/idkit";

export async function POST(request: Request): Promise<Response> {
  const { rp_id, idkitResponse } = (await request.json()) as {
    rp_id: string;
    idkitResponse: IDKitResult;
  };

  const response = await fetch(
    `https://developer.world.org/api/v4/verify/${rp_id}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(idkitResponse),
    },
  );

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return NextResponse.json(
      { error: data.detail ?? data.error ?? "Verification failed" },
      { status: 400 },
    );
  }

  const item = idkitResponse?.responses?.[0] as unknown as Record<string, unknown> | undefined;
  const nullifier_hash = item && "nullifier" in item ? String(item.nullifier) : "";

  return NextResponse.json({ verified: true, nullifier_hash });
}

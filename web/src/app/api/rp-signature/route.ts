import { NextResponse } from "next/server";
import { signRequest } from "@worldcoin/idkit-core/signing";

export async function POST(request: Request): Promise<Response> {
  const { action } = await request.json();

  const raw = process.env.WORLD_RP_SIGNING_KEY ?? "";
  const signingKeyHex = raw.startsWith("0x") ? raw.slice(2) : raw;

  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex,
    action,
  });

  return NextResponse.json({
    sig,
    nonce,
    created_at: createdAt,
    expires_at: expiresAt,
  });
}

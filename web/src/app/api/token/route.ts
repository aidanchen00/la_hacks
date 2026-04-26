import { NextResponse } from "next/server";
import {
  AccessToken,
  RoomConfiguration,
  RoomAgentDispatch,
  type AccessTokenOptions,
  type VideoGrant,
} from "livekit-server-sdk";

const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;

export const revalidate = 0;

export async function POST(req: Request) {
  try {
    if (!LIVEKIT_URL || !API_KEY || !API_SECRET) {
      throw new Error("LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be set");
    }

    const url = new URL(req.url);
    const lang = url.searchParams.get("lang") || "en";
    const body = await req.json().catch(() => ({}));
    const participantIdentity = body.participant_identity || `user_${Math.floor(Math.random() * 10_000)}`;
    const participantName = body.participant_name || "User";
    const roomName = body.room_name || `intake-${lang}-${Date.now()}`;

    const at = new AccessToken(API_KEY, API_SECRET, {
      identity: participantIdentity,
      name: participantName,
      ttl: "15m",
    } as AccessTokenOptions);

    const grant: VideoGrant = {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canPublishData: true,
      canSubscribe: true,
    };
    at.addGrant(grant);

    // Always embed lang in metadata so the agent can read it reliably
    const existingMeta = body.metadata ? (typeof body.metadata === "string" ? JSON.parse(body.metadata) : body.metadata) : {};
    at.metadata = JSON.stringify({ ...existingMeta, lang });

    // Explicit agent dispatch — bypasses any project-level dispatch rules
    // that filter by room-name prefix. agentName="" matches any registered
    // agent worker, so all our personas (intake / altmed / mental) are
    // dispatched regardless of room name.
    at.roomConfig = new RoomConfiguration({
      agents: [
        new RoomAgentDispatch({
          agentName: "",
          metadata: JSON.stringify({ lang }),
        }),
      ],
    });

    const participantToken = await at.toJwt();

    return NextResponse.json(
      { serverUrl: LIVEKIT_URL, roomName, participantName, participantToken },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return new NextResponse(error instanceof Error ? error.message : "Internal server error", { status: 500 });
  }
}

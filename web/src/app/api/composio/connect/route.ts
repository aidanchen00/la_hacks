import { NextRequest, NextResponse } from "next/server";
import { entityFor } from "../_entity";

const TOOLKIT_SLUGS: Record<string, string[]> = {
  gmail: ["gmail"],
  googlesheets: ["googlesheets", "google_sheets"],
  googlecalendar: ["googlecalendar", "google_calendar"],
  googledrive: ["googledrive", "google_drive"],
};

const TOOLKIT_TO_ENTITY_KEY: Record<string, "gmail" | "sheets" | "calendar" | "drive"> = {
  gmail: "gmail",
  googlesheets: "sheets",
  googlecalendar: "calendar",
  googledrive: "drive",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matchesToolkit(a: any, toolkit: string): boolean {
  const slug: string = (a.toolkit?.slug ?? a.toolkitSlug ?? a.appName ?? "").toLowerCase();
  return (TOOLKIT_SLUGS[toolkit] ?? [toolkit]).includes(slug);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getComposio(): any {
  const { Composio } = require("@composio/core");
  return new Composio({ apiKey: process.env.COMPOSIO_API_KEY! });
}

export async function GET(request: NextRequest) {
  const toolkit = request.nextUrl.searchParams.get("toolkit") ?? "gmail";
  // Allow ad-hoc override (e.g. ?userId=cris-refire) when the per-toolkit env
  // var hasn't been set yet — useful while wiring up a brand-new connection.
  const overrideUserId = request.nextUrl.searchParams.get("userId");
  const entityId = overrideUserId
    ?? (TOOLKIT_TO_ENTITY_KEY[toolkit] ? entityFor(TOOLKIT_TO_ENTITY_KEY[toolkit]) : (process.env.COMPOSIO_USER_ID ?? "default"));
  try {
    const composio = getComposio();
    const accounts = await composio.connectedAccounts.list({ entityId });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acct = accounts.items?.find((a: any) => matchesToolkit(a, toolkit));
    if (acct && (acct as { status: string }).status === "ACTIVE") {
      return NextResponse.json({ connected: true, toolkit });
    }
    const result = await composio.tools.execute("COMPOSIO_INITIATE_CONNECTION", {
      userId: entityId,
      arguments: { toolkit, redirect_url: "http://localhost:3000" },
      dangerouslySkipVersionCheck: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (result.data as any)?.response_data;
    return NextResponse.json({ connected: false, toolkit, authUrl: data?.redirect_url ?? null });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

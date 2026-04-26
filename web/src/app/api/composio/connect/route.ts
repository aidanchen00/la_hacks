import { NextRequest, NextResponse } from "next/server";
import { entityFor } from "../_entity";
import { authConfigFor } from "../_auth_configs";

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
  const overrideAuthConfig = request.nextUrl.searchParams.get("authConfigId");
  const entityKey = TOOLKIT_TO_ENTITY_KEY[toolkit];
  const entityId = overrideUserId
    ?? (entityKey ? entityFor(entityKey) : (process.env.COMPOSIO_USER_ID ?? "default"));
  const authConfigId = overrideAuthConfig
    ?? (entityKey ? authConfigFor(entityKey) : undefined);
  try {
    const composio = getComposio();
    const accounts = await composio.connectedAccounts.list({ entityId });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acct = accounts.items?.find((a: any) => matchesToolkit(a, toolkit));
    if (acct && (acct as { status: string }).status === "ACTIVE") {
      return NextResponse.json({ connected: true, toolkit, entityId });
    }
    // Two paths: when an auth_config_id is provided, use the v3
    // connectedAccounts.initiate() flow (which expects auth_config_id).
    // When omitted, fall back to the legacy COMPOSIO_INITIATE_CONNECTION
    // tool (which uses Composio's default OAuth app).
    if (authConfigId) {
      const conn = await composio.connectedAccounts.initiate(entityId, authConfigId, {
        callbackUrl: "http://localhost:3000",
      });
      return NextResponse.json({
        connected: false,
        toolkit,
        entityId,
        authConfigId,
        authUrl: conn.redirectUrl ?? conn.redirect_url ?? null,
        connectionId: conn.id ?? conn.connectionId ?? null,
      });
    }
    const result = await composio.tools.execute("COMPOSIO_INITIATE_CONNECTION", {
      userId: entityId,
      arguments: { toolkit, redirect_url: "http://localhost:3000" },
      dangerouslySkipVersionCheck: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (result.data as any)?.response_data;
    return NextResponse.json({
      connected: false, toolkit, entityId,
      authUrl: data?.redirect_url ?? null,
      hint: "No auth_config_id set. Set COMPOSIO_AUTH_CONFIG_<TOOLKIT> env or pass ?authConfigId=ac_xxx to use a custom OAuth app.",
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

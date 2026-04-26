import { NextRequest, NextResponse } from "next/server";
import { entityFor } from "../_entity";

export const maxDuration = 30;

interface CalendarBookingPayload {
  /** Provider name (e.g. "Dr. Sarah Chen") */
  provider?: string;
  /** Specialty (e.g. "Primary Care") */
  specialty?: string;
  /** Source platform that surfaced the listing (ZocDoc, Solv, Healthgrades, …) */
  source?: string;
  /** Address shown on the listing — goes into the event location field */
  address?: string;
  /** Time string from the listing — used as the event description */
  time?: string;
  /** Listing URL — appended to the description so the user can revisit it */
  listingUrl?: string;
  /** Out-of-pocket dollar amount paid via Stripe */
  amountPaid?: number;
  /** Prana run id for audit trail */
  runId?: string;
  /** ISO 8601 start time. Defaults to next available 10am tomorrow. */
  startIso?: string;
  /** Duration in minutes (defaults to 30) */
  durationMinutes?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getComposio(): any {
  const { Composio } = require("@composio/core");
  return new Composio({ apiKey: process.env.COMPOSIO_API_KEY! });
}

function defaultStartIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as CalendarBookingPayload;
  const entityId = entityFor("calendar");

  const startIso = body.startIso ?? defaultStartIso();
  const durationMin = body.durationMinutes ?? 30;
  const endIso = new Date(new Date(startIso).getTime() + durationMin * 60_000).toISOString();

  const provider = body.provider ?? "Healthcare Provider";
  const specialty = body.specialty ?? "Appointment";
  const summary = `${specialty} — ${provider}`;

  const descLines: string[] = [];
  if (body.source) descLines.push(`Booked via ${body.source}`);
  if (body.time) descLines.push(`Listing time: ${body.time}`);
  if (typeof body.amountPaid === "number" && body.amountPaid > 0) {
    descLines.push(`Paid: $${body.amountPaid.toFixed(2)}`);
  }
  if (body.runId) descLines.push(`Prana run: ${body.runId}`);
  if (body.listingUrl) descLines.push(`\nListing: ${body.listingUrl}`);
  descLines.push("\nLogged automatically by Prana — verify directly with the provider.");
  const description = descLines.join("\n");

  try {
    const composio = getComposio();
    const result = await composio.tools.execute("GOOGLECALENDAR_CREATE_EVENT", {
      userId: entityId,
      arguments: {
        calendar_id: "primary",
        summary,
        description,
        location: body.address ?? "",
        start_datetime: startIso,
        end_datetime: endIso,
        // Composio's GOOGLECALENDAR_CREATE_EVENT also accepts these — IANA tz
        // is required by Google for non-UTC offsets.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles",
      },
      dangerouslySkipVersionCheck: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = result as any;
    if (r?.successful === false || r?.error) {
      return NextResponse.json({
        logged: false,
        error: r.error ?? r.message ?? "Composio reported failure",
        composio: r,
      }, { status: 500 });
    }
    const data = r?.data ?? {};
    return NextResponse.json({
      logged: true,
      eventId: data.id ?? data.event_id ?? null,
      htmlLink: data.htmlLink ?? data.html_link ?? null,
      start: startIso,
      end: endIso,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isNotConnected =
      /No connected account|ConnectedAccountNotFound|toolkit.*not.*connected/i.test(msg);
    if (isNotConnected) {
      return NextResponse.json(
        { logged: false, calendarNotConnected: true, message: msg },
        { status: 200 },
      );
    }
    return NextResponse.json({ logged: false, error: msg }, { status: 500 });
  }
}

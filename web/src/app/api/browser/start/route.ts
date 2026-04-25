import { NextRequest, NextResponse } from "next/server";
import { BrowserUse } from "browser-use-sdk/v3";

export const maxDuration = 120;

type BrowserMode = "doctor" | "pharmacy";

const DOCTOR_SITES = ["ZocDoc", "Healthgrades", "Solv"] as const;
const PHARMACY_SITES = ["CVS", "Walgreens", "GoodRx"] as const;

const DOCTOR_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string" },
    appointments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          provider: { type: "string" },
          specialty: { type: ["string", "null"] },
          time: { type: ["string", "null"] },
          address: { type: ["string", "null"] },
          listingUrl: { type: ["string", "null"] },
          acceptsInsurance: { type: ["boolean", "null"] },
        },
        required: ["provider"],
      },
    },
  },
  required: ["source", "appointments"],
};

const PHARMACY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          price: { type: ["string", "null"] },
          dosage: { type: ["string", "null"] },
          listingUrl: { type: ["string", "null"] },
          requiresPrescription: { type: ["boolean", "null"] },
        },
        required: ["name"],
      },
    },
  },
  required: ["source", "items"],
};

function buildDoctorTask(site: string, specialty: string, location: string): string {
  const urls: Record<string, string> = {
    ZocDoc: "https://www.zocdoc.com",
    Healthgrades: "https://www.healthgrades.com",
    Solv: "https://www.solvhealth.com",
  };
  return [
    `You are a healthcare appointment search agent using ${site}.`,
    `1. Go to ${urls[site]} and wait until the page is fully interactive.`,
    `2. Search for "${specialty}" doctors in "${location}". Use the site's search inputs; press Enter to submit.`,
    `3. WAIT for the search results page to render — scroll the results list once if needed so providers are visible.`,
    `4. Extract up to 5 providers with: provider name, specialty, address, earliest available appointment time, listingUrl (the absolute URL to the provider's profile/booking page on ${site}), and acceptsInsurance (true/false/null).`,
    `5. Do NOT stop until you have either extracted at least one provider OR confirmed the search returned zero results. Retry the search once if the first attempt hits a captcha or empty page.`,
    `6. Return STRICT JSON: {"source": "${site}", "appointments": [{"provider": ..., "specialty": ..., "time": ..., "address": ..., "listingUrl": ..., "acceptsInsurance": ...}, ...] }.`,
    `IMPORTANT: Wellness care navigation only — no medical advice.`,
  ].join("\n");
}

function buildPharmacyTask(site: string, query: string): string {
  const urls: Record<string, string> = {
    CVS: "https://www.cvs.com",
    Walgreens: "https://www.walgreens.com",
    GoodRx: "https://www.goodrx.com",
  };
  return [
    `You are a pharmacy/wellness product search agent using ${site}.`,
    `1. Go to ${urls[site]}`,
    `2. Search for "${query}"`,
    "3. List up to 5 relevant OTC products with price, dosage info, and listing URL.",
    "4. Mark requiresPrescription=true ONLY if it is clearly a prescription-only medication.",
    "5. Return JSON with source and items array.",
    "DISCLAIMER: This information is for educational purposes only. Consult a licensed pharmacist or doctor before purchasing medications.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Mock fixtures (used when MOCK_BROWSER_USE=1 or quota is exhausted)
// ---------------------------------------------------------------------------

function buildMockSession(agent: string, mode: BrowserMode) {
  const id = `mock_${agent.toLowerCase()}_${Date.now().toString(36)}`;
  const liveUrl = mode === "doctor"
    ? { ZocDoc: "https://www.zocdoc.com", Healthgrades: "https://www.healthgrades.com", Solv: "https://www.solvhealth.com" }[agent]
    : { CVS: "https://www.cvs.com", Walgreens: "https://www.walgreens.com", GoodRx: "https://www.goodrx.com" }[agent];
  return { agent, sessionId: id, liveUrl: liveUrl ?? "", status: "completed", mock: true };
}

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /quota|limit|billing period|too many|insufficient/i.test(msg);
}

async function killActiveSessions(client: BrowserUse): Promise<{ killed: number; failed: number }> {
  let killed = 0;
  let failed = 0;
  try {
    const list = await client.sessions.list({ page_size: 50 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const active = (list.sessions ?? []).filter((s: any) => s.status === "active");
    if (active.length === 0) return { killed: 0, failed: 0 };

    const outcomes = await Promise.allSettled(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      active.map((s: any) => client.sessions.stop(s.id, { strategy: "session" }))
    );
    killed = outcomes.filter((o) => o.status === "fulfilled").length;
    failed = outcomes.filter((o) => o.status === "rejected").length;
  } catch (e) {
    console.warn("[browser/start] killActiveSessions failed:", e instanceof Error ? e.message : e);
  }
  return { killed, failed };
}

export async function POST(request: NextRequest) {
  const { mode, query, location } = (await request.json()) as {
    mode: BrowserMode;
    query?: string;
    location?: string;
  };

  if (!mode) {
    return NextResponse.json({ error: "mode is required (doctor|pharmacy)" }, { status: 400 });
  }

  const sites = mode === "doctor" ? DOCTOR_SITES : PHARMACY_SITES;
  const forceMock = process.env.MOCK_BROWSER_USE === "1" || !process.env.BROWSER_USE_API_KEY;

  // Mock mode: skip the SDK entirely, return fixture sessions.
  if (forceMock) {
    const sessions = sites.map((site) => buildMockSession(site, mode));
    return NextResponse.json({ mode, sessions, started: sessions.length, killed: 0, mock: true });
  }

  const client = new BrowserUse({ apiKey: process.env.BROWSER_USE_API_KEY });

  // Free up the 3-concurrent quota: kill any leftover active sessions before starting new ones
  const cleanup = await killActiveSessions(client);
  if (cleanup.killed > 0) {
    console.info(`[browser/start] cleaned up ${cleanup.killed} active session(s) (${cleanup.failed} failed)`);
  }

  const specialty = query || "primary care";
  const loc = location || "Los Angeles, CA";
  const pharmQuery = query || "over the counter pain relief";

  const outcomes = await Promise.allSettled(
    sites.map(async (site) => {
      const session = await client.sessions.create({
        keepAlive: true,
        task: mode === "doctor" ? buildDoctorTask(site, specialty, loc) : buildPharmacyTask(site, pharmQuery),
        model: "gemini-3-flash",
        outputSchema: mode === "doctor" ? DOCTOR_OUTPUT_SCHEMA : PHARMACY_OUTPUT_SCHEMA,
      });
      return { agent: site, sessionId: session.id, liveUrl: session.liveUrl ?? "", status: String(session.status ?? "") };
    })
  );

  // Per-site fallback: any site that failed with a quota / billing error gets
  // replaced with a mock fixture so the demo keeps working even when only some
  // of the BrowserUse task budget is left. Non-quota errors still surface so
  // they're not silently masked.
  let quotaSubstitutions = 0;
  const sessions = outcomes.map((o, i) => {
    if (o.status === "fulfilled") return o.value;
    if (isQuotaError(o.reason)) {
      quotaSubstitutions++;
      return { ...buildMockSession(sites[i], mode), quotaFallback: true };
    }
    return {
      agent: sites[i], sessionId: "", liveUrl: "", status: "error",
      error: o.reason instanceof Error ? o.reason.message : "Failed",
    };
  });

  if (quotaSubstitutions > 0) {
    console.warn(`[browser/start] ${quotaSubstitutions}/${sites.length} site(s) over quota — substituted with mocks`);
  }

  const allMock = sessions.every((s) => "mock" in s && s.mock);
  return NextResponse.json({
    mode,
    sessions,
    started: sessions.filter((s) => s.sessionId).length,
    killed: cleanup.killed,
    quotaSubstitutions,
    quotaExhausted: allMock && quotaSubstitutions > 0,
    mock: allMock,
  });
}

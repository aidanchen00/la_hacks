import { NextRequest, NextResponse } from "next/server";
import { BrowserUse, type BuModel } from "browser-use-sdk/v3";

export const maxDuration = 120;

type BrowserMode = "doctor" | "pharmacy";

// ZocDoc removed — heavy anti-bot wall blocks even bu-max.
const DOCTOR_SITES = ["Healthgrades", "Solv"] as const;
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
  // Search-results URLs as a fallback: CVS/Walgreens often show heavy
  // anti-bot interstitials on the homepage but render results directly when
  // navigating to the search URL. Try both.
  const homeUrls: Record<string, string> = {
    CVS: "https://www.cvs.com",
    Walgreens: "https://www.walgreens.com",
    GoodRx: "https://www.goodrx.com",
  };
  const searchUrls: Record<string, string> = {
    CVS: `https://www.cvs.com/search?searchTerm=${encodeURIComponent(query)}`,
    Walgreens: `https://www.walgreens.com/search/results.jsp?Ntt=${encodeURIComponent(query)}`,
    GoodRx: `https://www.goodrx.com/search?query=${encodeURIComponent(query)}`,
  };
  return [
    `You are a pharmacy/wellness product search agent using ${site}.`,
    `1. Go directly to the search results URL: ${searchUrls[site]}. If that URL fails to load or shows an error, fall back to ${homeUrls[site]} and use the on-page search input to look up "${query}".`,
    `2. WAIT for the page to be fully interactive. If you see a CAPTCHA, cookie banner, "Are you human", region picker, age gate, or "Press & Hold" challenge — close/dismiss it and continue. Do NOT stop on the first interstitial.`,
    `3. SCROLL the results list at least once so product cards are visible. If the page is still loading after the first scroll, wait 2 seconds and scroll again.`,
    `4. Extract up to 5 OTC product results most relevant to "${query}". For each, capture: name, price (number, no currency symbol), dosage if shown (e.g. "200 mg"), listingUrl (the absolute URL to the product detail page on ${site}), and requiresPrescription (true ONLY if the product is clearly Rx-only — assume false for OTC items).`,
    `5. Persistence rule: do NOT mark this task complete until you have EITHER (a) extracted at least one product, OR (b) confirmed via on-page text that the search returned zero results. If the first attempt hits a captcha or empty state, RETRY the search once via the search input.`,
    `6. Return STRICT JSON matching this shape: {"source": "${site}", "items": [{"name": "...", "price": "...", "dosage": "...", "listingUrl": "...", "requiresPrescription": false}, ...]}.`,
    `DISCLAIMER: Wellness/education only. The user should consult a licensed pharmacist before purchase.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Mock fixtures (used when MOCK_BROWSER_USE=1 or quota is exhausted)
// ---------------------------------------------------------------------------

function buildMockSession(agent: string, mode: BrowserMode) {
  const id = `mock_${agent.toLowerCase()}_${Date.now().toString(36)}`;
  // Empty liveUrl on purpose — public sites block iframe embedding via
  // X-Frame-Options, so the UI renders a "Demo mode" placeholder instead.
  // done: true so the status poller skips it (no real session to fetch).
  return { agent, sessionId: id, liveUrl: "", status: "completed", done: true, mock: true, mode };
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
      // Both modes default to bu-max — ZocDoc and CVS/GoodRx all have anti-bot
      // walls that gpt-5.4-mini gets stuck on. bu-max is BrowserUse's
      // browser-tuned model and bills BU credits but actually navigates them.
      // Healthgrades works fine on either model; per-site override isn't worth
      // the complexity.
      const model = (
        mode === "pharmacy"
          ? (process.env.BROWSER_USE_PHARMACY_MODEL ?? "bu-max")
          : (process.env.BROWSER_USE_DOCTOR_MODEL ?? "bu-max")
      ) as BuModel;
      const session = await client.sessions.create({
        keepAlive: true,
        task: mode === "doctor" ? buildDoctorTask(site, specialty, loc) : buildPharmacyTask(site, pharmQuery),
        model,
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

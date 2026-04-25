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
    `1. Go to ${urls[site]}`,
    `2. Search for "${specialty}" doctors in "${location}"`,
    "3. List up to 5 providers with their earliest available appointment time, address, and listing URL.",
    "4. Return JSON with source and appointments array.",
    "IMPORTANT: This is for wellness care navigation only. Do not share medical advice.",
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

export async function POST(request: NextRequest) {
  const { mode, query, location } = (await request.json()) as {
    mode: BrowserMode;
    query?: string;
    location?: string;
  };

  if (!mode) {
    return NextResponse.json({ error: "mode is required (doctor|pharmacy)" }, { status: 400 });
  }

  const client = new BrowserUse({ apiKey: process.env.BROWSER_USE_API_KEY });

  if (mode === "doctor") {
    const specialty = query || "primary care";
    const loc = location || "Los Angeles, CA";
    const sites = DOCTOR_SITES;

    const outcomes = await Promise.allSettled(
      sites.map(async (site) => {
        const session = await client.sessions.create({
          keepAlive: true,
          task: buildDoctorTask(site, specialty, loc),
          model: "gemini-3-flash",
          outputSchema: DOCTOR_OUTPUT_SCHEMA,
        });
        return { agent: site, sessionId: session.id, liveUrl: session.liveUrl ?? "", status: String(session.status ?? "") };
      })
    );

    const sessions = outcomes.map((o, i) =>
      o.status === "fulfilled"
        ? o.value
        : { agent: sites[i], sessionId: "", liveUrl: "", status: "error", error: o.reason instanceof Error ? o.reason.message : "Failed" }
    );

    return NextResponse.json({ mode, sessions, started: sessions.filter((s) => s.sessionId).length });
  } else {
    const pharmQuery = query || "over the counter pain relief";
    const sites = PHARMACY_SITES;

    const outcomes = await Promise.allSettled(
      sites.map(async (site) => {
        const session = await client.sessions.create({
          keepAlive: true,
          task: buildPharmacyTask(site, pharmQuery),
          model: "gemini-3-flash",
          outputSchema: PHARMACY_OUTPUT_SCHEMA,
        });
        return { agent: site, sessionId: session.id, liveUrl: session.liveUrl ?? "", status: String(session.status ?? "") };
      })
    );

    const sessions = outcomes.map((o, i) =>
      o.status === "fulfilled"
        ? o.value
        : { agent: sites[i], sessionId: "", liveUrl: "", status: "error", error: o.reason instanceof Error ? o.reason.message : "Failed" }
    );

    return NextResponse.json({ mode, sessions, started: sessions.filter((s) => s.sessionId).length });
  }
}

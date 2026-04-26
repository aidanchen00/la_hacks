import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Bridge: BrowserUse JSON output → shopping_cart row.
// Lets the visible browser panels on /pharmacy/[runId] populate the cart
// directly, bypassing the Fetch.ai bureau handshake.
//
// Body shape:
//   { run_id, agent, platform, items: [{name, price, listingUrl?, dosage?, requiresPrescription?}] }

interface ItemIn {
  name?: string | null;
  price?: number | string | null;
  listingUrl?: string | null;
  dosage?: string | null;
  requiresPrescription?: boolean | null;
}

function toPrice(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const m = v.replace(/[^\d.]/g, "");
    const n = parseFloat(m);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export async function POST(req: NextRequest) {
  const { run_id, agent, platform, items } = (await req.json()) as {
    run_id?: string;
    agent?: string;
    platform?: string;
    items?: ItemIn[];
  };

  if (!run_id || !platform || !Array.isArray(items)) {
    return NextResponse.json({ inserted: 0, error: "run_id, platform, items[] required" }, { status: 400 });
  }

  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO shopping_cart (run_id, agent_name, platform, item_name, item_price, item_url, item_description, in_stock)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Wipe any prior rows from this (run_id, platform) so re-runs don't duplicate
  db.prepare("DELETE FROM shopping_cart WHERE run_id = ? AND platform = ?").run(run_id, platform);

  // Mirror the Fetch.ai shopping agent contract: one best pick per platform.
  // BrowserUse is instructed to return items in relevance order, so item[0]
  // is the agent's "pick". Surfacing all 5 makes the cart look like a search
  // page; the demo wants a curated 1-per-source list.
  const top = items.find((it) => it?.name) ?? null;
  if (top) {
    const desc = [top.dosage, top.requiresPrescription ? "Rx required" : null]
      .filter(Boolean)
      .join(" · ") || null;
    stmt.run(run_id, agent ?? platform.toLowerCase(), platform, top.name, toPrice(top.price), top.listingUrl ?? null, desc, 1);
    return NextResponse.json({ inserted: 1, run_id, platform });
  }

  return NextResponse.json({ inserted: 0, run_id, platform });
}

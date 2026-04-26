import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// GET /api/cart/[runId] — return shopping_cart rows for a run, regardless of
// whether a Fetch.ai budget_session exists. The Python /budget/{run_id} 404s
// if the bureau never started, which is why bridge-inserted carts were invisible.

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const rows = getDb()
    .prepare(
      `SELECT id, run_id, agent_name, platform, item_name, item_price, item_url,
              item_description, in_stock, created_at
       FROM shopping_cart
       WHERE run_id = ?
       ORDER BY created_at ASC`,
    )
    .all(runId);
  return NextResponse.json({ cart: rows });
}

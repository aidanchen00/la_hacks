import { NextRequest, NextResponse } from "next/server";
import { entityFor } from "../_entity";

export const maxDuration = 30;

interface RedditPostPayload {
  /** Subreddit name without the "r/" prefix (e.g. "wellness", "ChronicPain"). */
  subreddit?: string;
  /** Post title — Reddit caps at 300 chars. */
  title?: string;
  /** Post body for text/self posts. */
  text?: string;
  /** External URL for link posts. If set, kind defaults to "link". */
  url?: string;
  /** "self" (text) or "link". Inferred from presence of `url` if omitted. */
  kind?: "self" | "link";
  /** NSFW flag. */
  nsfw?: boolean;
  /** Spoiler flag. */
  spoiler?: boolean;
  /** Free-form Prana run id for audit logging only — never sent to Reddit. */
  runId?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getComposio(): any {
  const { Composio } = require("@composio/core");
  return new Composio({ apiKey: process.env.COMPOSIO_API_KEY! });
}

const DEFAULT_SUBREDDIT = process.env.PRANA_REDDIT_SUBREDDIT ?? "test";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as RedditPostPayload;
  const entityId = entityFor("reddit");

  const subreddit = (body.subreddit ?? DEFAULT_SUBREDDIT).replace(/^r\//, "").trim();
  const title = (body.title ?? "").trim().slice(0, 300);
  const kind = body.kind ?? (body.url ? "link" : "self");
  const text = body.text ?? "";
  const url = body.url ?? "";

  if (!subreddit) {
    return NextResponse.json({ posted: false, error: "subreddit required" }, { status: 400 });
  }
  if (!title) {
    return NextResponse.json({ posted: false, error: "title required" }, { status: 400 });
  }
  if (kind === "link" && !url) {
    return NextResponse.json({ posted: false, error: "url required for link post" }, { status: 400 });
  }
  if (kind === "self" && !text) {
    return NextResponse.json({ posted: false, error: "text required for self post" }, { status: 400 });
  }

  try {
    const composio = getComposio();
    // Composio's Reddit toolkit action for creating a new submission.
    // Args mirror Reddit's /api/submit endpoint.
    const result = await composio.tools.execute("REDDIT_CREATE_REDDIT_POST", {
      userId: entityId,
      arguments: {
        subreddit,
        title,
        kind,
        text: kind === "self" ? text : undefined,
        url:  kind === "link" ? url  : undefined,
        nsfw: !!body.nsfw,
        spoiler: !!body.spoiler,
        // sendreplies left at Composio default (true on Reddit) — non-critical.
      },
      dangerouslySkipVersionCheck: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = result as any;
    if (r?.successful === false || r?.error) {
      return NextResponse.json({
        posted: false,
        error: r.error ?? r.message ?? "Composio reported failure",
        composio: r,
      }, { status: 500 });
    }

    // Reddit returns the post URL inside data.json.data.url (canonical) or
    // data.url (older). Normalize both to a single field.
    const data = r?.data ?? {};
    const inner = data?.json?.data ?? {};
    const postUrl = inner.url ?? data.url ?? data.shortlink ?? null;
    const postId = inner.id ?? data.id ?? data.name ?? null;

    return NextResponse.json({
      posted: true,
      url: postUrl,
      postId,
      subreddit,
      title,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isNotConnected =
      /No connected account|ConnectedAccountNotFound|toolkit.*not.*connected/i.test(msg);
    if (isNotConnected) {
      return NextResponse.json(
        { posted: false, redditNotConnected: true, message: msg },
        { status: 200 },
      );
    }
    return NextResponse.json({ posted: false, error: msg }, { status: 500 });
  }
}

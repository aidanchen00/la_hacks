"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";

interface RedditShareModalProps {
  /** Subreddit to post to (without r/ prefix). Locked — user cannot change. */
  subreddit: string;
  /** Pre-filled title (typically a 1-line teaser of the routing summary). */
  defaultTitle: string;
  /** Pre-filled body (markdown). */
  defaultBody: string;
  /** Optional Prana run id, included with the POST for server-side audit only. */
  runId?: string;
  onClose: () => void;
}

interface PostResponse {
  posted: boolean;
  url?: string | null;
  postId?: string | null;
  subreddit?: string;
  title?: string;
  error?: string;
  redditNotConnected?: boolean;
  message?: string;
}

const TITLE_MAX = 300;
const BODY_MAX = 40_000;

export default function RedditShareModal({
  subreddit,
  defaultTitle,
  defaultBody,
  runId,
  onClose,
}: RedditShareModalProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState(defaultBody);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<PostResponse | null>(null);

  // Subreddit is fixed by the prop — no useState. Strip "r/" if the caller
  // accidentally included it so the API call stays clean.
  const targetSubreddit = subreddit.replace(/^r\//, "").trim();

  const titleCount = useMemo(() => title.length, [title]);
  const bodyCount = useMemo(() => body.length, [body]);
  const canSubmit = targetSubreddit.length > 0 && title.trim().length > 0 && body.trim().length > 0 && !submitting;

  // Esc to close (matches the doctor-page modal UX).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/composio/reddit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subreddit: targetSubreddit,
          title: title.trim(),
          text: body,
          kind: "self",
          runId,
        }),
      });
      const data = (await res.json()) as PostResponse;
      setResult(data);
    } catch (e) {
      setResult({ posted: false, error: e instanceof Error ? e.message : "Request failed" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[1000] flex items-center justify-center px-4 py-6"
      style={{ background: "rgba(31,58,46,0.45)" }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="rounded-2xl w-full max-w-xl overflow-y-auto"
        style={{
          background: "#F4F1EA",
          border: "1px solid rgba(31,58,46,0.15)",
          maxHeight: "85vh",
          padding: "24px 28px",
        }}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="font-serif text-[#1F3A2E] text-2xl font-medium m-0">
              Share to Reddit
            </h2>
            <p className="text-xs text-[#6B7280] mt-1">
              Posted via your connected Reddit account. Review the text — it goes to your
              real account.
            </p>
          </div>
          <button
            onClick={onClose}
            className="bg-transparent border-none cursor-pointer text-[#6B7280] hover:text-[#1F3A2E]"
            style={{ fontSize: 22, padding: "0 6px", minHeight: 36 }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {result?.posted ? (
          <div className="bg-[#DCFCE7] border border-[#16A34A]/30 rounded-xl px-4 py-4">
            <div className="text-[#16A34A] font-semibold mb-1">✓ Posted</div>
            <div className="text-sm text-[#3D3D3D] mb-3">
              <strong>r/{result.subreddit}</strong> · {result.title}
            </div>
            {result.url ? (
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-[#1F3A2E] underline hover:opacity-70"
              >
                Open post on Reddit →
              </a>
            ) : (
              <span className="text-xs text-[#6B7280]">Posted, but Composio did not return a URL.</span>
            )}
            <div className="mt-4 flex justify-end">
              <button
                onClick={onClose}
                className="bg-[#1F3A2E] text-white rounded-full px-5 py-2 font-medium text-sm hover:bg-[#2A4D3D]"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-[#6B7280] mb-1.5">Posting to</label>
                <div
                  className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-sm font-medium"
                  style={{ background: "#FF4500", color: "#FFFFFF" }}
                >
                  <span aria-hidden>r/</span>
                  <span>{targetSubreddit}</span>
                </div>
                <p className="text-[10px] text-[#6B7280] mt-1.5">
                  Subreddit is fixed by the app — every Prana share goes to r/{targetSubreddit}.
                </p>
              </div>

              <div>
                <div className="flex items-baseline justify-between mb-1.5">
                  <label className="text-xs text-[#6B7280]">Title</label>
                  <span className={`text-[10px] ${titleCount > TITLE_MAX ? "text-[#DC2626]" : "text-[#6B7280]"}`}>
                    {titleCount}/{TITLE_MAX}
                  </span>
                </div>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))}
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50"
                  style={{ fontSize: 16 }}
                />
              </div>

              <div>
                <div className="flex items-baseline justify-between mb-1.5">
                  <label className="text-xs text-[#6B7280]">Body (markdown supported)</label>
                  <span className="text-[10px] text-[#6B7280]">{bodyCount}/{BODY_MAX}</span>
                </div>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value.slice(0, BODY_MAX))}
                  rows={10}
                  className="w-full bg-white border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50 font-mono text-sm resize-y"
                  style={{ fontSize: 14, minHeight: 180 }}
                />
              </div>
            </div>

            {result && !result.posted && (
              <div className="mt-4 bg-[#FEE2E2] border border-[#DC2626]/20 rounded-xl px-4 py-3 text-sm text-[#DC2626]">
                {result.redditNotConnected
                  ? <>Reddit isn&apos;t connected for this user yet. <a href="/api/composio/connect?toolkit=reddit" target="_blank" rel="noopener noreferrer" className="underline">Connect Reddit →</a></>
                  : (result.error ?? result.message ?? "Failed to post")}
              </div>
            )}

            <div className="flex gap-3 mt-5">
              <button
                onClick={onClose}
                className="flex-1 rounded-full font-medium text-sm cursor-pointer"
                style={{ background: "rgba(31,58,46,0.08)", color: "#1F3A2E", border: "none", minHeight: 44 }}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="flex-1 rounded-full font-medium text-sm cursor-pointer disabled:opacity-40"
                style={{ background: "#FF4500", color: "#FFFFFF", border: "none", minHeight: 44 }}
              >
                {submitting ? "Posting…" : `Post to r/${targetSubreddit}`}
              </button>
            </div>

            <p className="text-[10px] text-[#6B7280] mt-3 leading-relaxed">
              Heads up: Reddit posts are public. Don&apos;t include personal medical details
              or anything you wouldn&apos;t share with strangers.
            </p>
          </>
        )}
      </motion.div>
    </div>
  );
}

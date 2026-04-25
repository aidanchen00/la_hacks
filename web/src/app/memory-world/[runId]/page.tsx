"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useOdyssey } from "@odysseyml/odyssey/react";
import { credentialsFromDict } from "@odysseyml/odyssey";

export default function MemoryWorldPage() {
  const { runId } = useParams<{ runId: string }>();
  const [prompt, setPrompt] = useState("A peaceful beach at golden hour, warm waves, serene and calming");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [credentials, setCredentials] = useState<ReturnType<typeof credentialsFromDict> | null>(null);

  const odyssey = useOdyssey({
    handlers: {
      onConnected: (stream) => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      },
      onStreamStarted: () => setStreaming(true),
      onStreamEnded: () => setStreaming(false),
      onError: (err) => setError(err.message),
    },
  });

  const fetchCredentials = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/odyssey", { method: "POST" });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setCredentials(credentialsFromDict(data.credentials));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect to Odyssey");
    } finally {
      setLoading(false);
    }
  }, []);

  const startStream = async () => {
    if (!credentials) return;
    setError(null);
    setLoading(true);
    try {
      await odyssey.connect();
      await odyssey.startStream({
        prompt: `Calming, healing world: ${prompt}`,
        portrait: false,
        ...(imageFile ? { image: imageFile } : {}),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Stream failed");
      setStreaming(false);
    } finally {
      setLoading(false);
    }
  };

  const stopStream = async () => {
    try {
      await odyssey.endStream();
    } catch { /* ignore */ }
    odyssey.disconnect();
    setStreaming(false);
    if (videoRef.current) videoRef.current.srcObject = null;
    setCredentials(null);
  };

  useEffect(() => {
    fetchCredentials();
    return () => { odyssey.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once credentials are ready, connect + start
  useEffect(() => {
    if (credentials && !odyssey.isConnected && !streaming) {
      startStream();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentials]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setError("Please upload a JPEG or PNG image.");
      return;
    }
    setError(null);
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setImagePreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const relaunch = async () => {
    await stopStream();
    await fetchCredentials();
  };

  const statusLabel = () => {
    if (streaming) return "● Live";
    if (loading || odyssey.status === "connecting" || odyssey.status === "authenticating") return "Connecting…";
    if (odyssey.status === "failed") return "Failed";
    return "Idle";
  };

  const statusColor = () => {
    if (streaming) return "#34d399";
    if (odyssey.status === "failed") return "#f87171";
    return "#64748b";
  };

  return (
    <div style={{ minHeight: "100vh", padding: "32px 24px", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 28 }}>
        <a href={`/dashboard?run_id=${runId}`} style={{ color: "#64748b", fontSize: 14, textDecoration: "none" }}>← Dashboard</a>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>🌊 Memory World</h1>
        <span style={{ marginLeft: "auto", fontSize: 13, color: statusColor(), fontWeight: 600 }}>
          {statusLabel()}
        </span>
      </div>

      <p style={{ color: "#64748b", marginBottom: 28, lineHeight: 1.6, maxWidth: 600 }}>
        Describe a calming memory or place and CareFlow will generate a live immersive video stream to help you relax and restore.
      </p>

      {/* Live video */}
      <div style={{ position: "relative", borderRadius: 16, overflow: "hidden", border: "1px solid var(--border)", background: "#0f172a", marginBottom: 24, aspectRatio: "16/9" }}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={false}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
        {!streaming && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#475569", fontSize: 14 }}>
            {loading || odyssey.status === "connecting" || odyssey.status === "authenticating"
              ? "Connecting to live stream…"
              : "Stream not started"}
          </div>
        )}
      </div>

      {error && (
        <div style={{ color: "#f87171", fontSize: 13, marginBottom: 16, background: "rgba(248,113,113,0.08)", borderRadius: 8, padding: "10px 14px" }}>
          {error}
        </div>
      )}

      <div className="card" style={{ maxWidth: 600 }}>
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 13, color: "#64748b", display: "block", marginBottom: 6 }}>Describe your calming memory or place</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            disabled={streaming}
            style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 14px", color: "#e2e8f0", fontSize: 14, resize: "vertical", opacity: streaming ? 0.5 : 1 }}
          />
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 13, color: "#64748b", display: "block", marginBottom: 6 }}>Optional: seed image (JPEG/PNG)</label>
          <div
            onClick={() => !streaming && fileRef.current?.click()}
            style={{ border: "2px dashed var(--border)", borderRadius: 12, padding: 16, textAlign: "center", cursor: streaming ? "default" : "pointer", opacity: streaming ? 0.5 : 1 }}
          >
            {imagePreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imagePreview} alt="preview" style={{ maxHeight: 120, borderRadius: 8, objectFit: "contain" }} />
            ) : (
              <div style={{ color: "#475569", fontSize: 13 }}>Click to upload image → used as visual seed</div>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png" style={{ display: "none" }} onChange={handleFileChange} />
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          {streaming ? (
            <button className="btn-primary" onClick={stopStream} style={{ background: "#ef4444" }}>
              Stop Stream
            </button>
          ) : (
            <button className="btn-primary" onClick={relaunch} disabled={loading}>
              {loading ? "Starting…" : "Start Livestream"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

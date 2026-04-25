"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useOdyssey } from "@odysseyml/odyssey/react";
import { credentialsFromDict } from "@odysseyml/odyssey";
import { motion } from "motion/react";
import LanguagePicker from "@/app/components/LanguagePicker";

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
    apiKey: process.env.NEXT_PUBLIC_ODYSSEY_API_KEY,
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
    try { await odyssey.endStream(); } catch { /* ignore */ }
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
    if (streaming) return "#16A34A";
    if (odyssey.status === "failed") return "#DC2626";
    return "#6B7280";
  };

  return (
    <div className="min-h-screen bg-[#F4F1EA]">
      <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <a
            href={`/dashboard?run_id=${runId}`}
            className="text-[#1F3A2E] text-sm font-medium hover:opacity-70 transition-opacity min-h-[44px] flex items-center"
          >
            ← Dashboard
          </a>
          <h1 className="font-serif text-[#1F3A2E] text-xl sm:text-2xl font-medium">Memory World</h1>
          <div className="ml-auto flex items-center gap-3">
            <span
              className="text-xs font-semibold uppercase tracking-wider"
              style={{ color: statusColor() }}
            >
              {statusLabel()}
            </span>
            <LanguagePicker />
          </div>
        </div>

        <p className="text-[#6B7280] text-sm mb-6 max-w-xl leading-relaxed">
          Describe a calming memory or place and Prana will generate a live immersive video stream
          to help you relax and restore.
        </p>

        {/* Live video */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative rounded-2xl overflow-hidden border border-[#1F3A2E]/15 bg-[#1F3A2E] mb-6"
          style={{ aspectRatio: "16/9" }}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={false}
            className="w-full h-full object-cover block"
          />
          {!streaming && (
            <div className="absolute inset-0 flex items-center justify-center text-[#EFEAE0]/60 text-sm">
              {loading || odyssey.status === "connecting" || odyssey.status === "authenticating"
                ? "Connecting to live stream…"
                : "Stream not started"}
            </div>
          )}
        </motion.div>

        {error && (
          <div className="bg-[#FEE2E2] border border-[#DC2626]/20 rounded-2xl px-4 py-3 mb-4 text-sm text-[#DC2626]">
            {error}
          </div>
        )}

        <div className="bg-[#EFEAE0] rounded-2xl p-6 max-w-xl">
          <div className="mb-4">
            <label className="block text-sm text-[#6B7280] mb-2">Describe your calming memory or place</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              disabled={streaming}
              className="w-full bg-[#F4F1EA] border border-[#1F3A2E]/20 rounded-xl px-4 py-3 text-[#3D3D3D] focus:outline-none focus:border-[#1F3A2E]/50 resize-y disabled:opacity-50"
              style={{ fontSize: 16 }}
            />
          </div>

          <div className="mb-5">
            <label className="block text-sm text-[#6B7280] mb-2">Optional: seed image (JPEG/PNG)</label>
            <div
              onClick={() => !streaming && fileRef.current?.click()}
              className={`border-2 border-dashed border-[#1F3A2E]/20 rounded-xl p-4 text-center transition-colors ${
                streaming ? "opacity-50 cursor-default" : "cursor-pointer hover:border-[#1F3A2E]/40"
              }`}
            >
              {imagePreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imagePreview} alt="preview" className="max-h-32 rounded-lg object-contain mx-auto" />
              ) : (
                <div className="text-[#6B7280] text-sm">Click to upload image → used as visual seed</div>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          <div className="flex gap-3">
            {streaming ? (
              <motion.button
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                onClick={stopStream}
                className="flex-1 bg-[#DC2626] text-white rounded-full font-medium text-sm hover:bg-[#B91C1C] transition-colors min-h-[48px]"
              >
                Stop Stream
              </motion.button>
            ) : (
              <motion.button
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                onClick={relaunch}
                disabled={loading}
                className="flex-1 bg-[#1F3A2E] text-white rounded-full font-medium text-sm hover:bg-[#2A4D3D] transition-colors disabled:opacity-40 min-h-[48px]"
              >
                {loading ? "Starting…" : "Start Livestream"}
              </motion.button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

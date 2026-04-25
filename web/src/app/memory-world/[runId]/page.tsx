"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams } from "next/navigation";

interface MediaItem {
  id: number;
  run_id: string | null;
  file_path: string;
  created_at: string;
}

export default function MemoryWorldPage() {
  const { runId } = useParams<{ runId: string }>();
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [prompt, setPrompt] = useState("A peaceful beach at golden hour, warm waves, serene and calming");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gallery, setGallery] = useState<MediaItem[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadGallery = useCallback(async () => {
    try {
      const res = await fetch("/api/media");
      const data = await res.json();
      setGallery(data.items ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadGallery(); }, [loadGallery]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setError("Please upload a JPEG or PNG image.");
      return;
    }
    setError(null);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target?.result as string;
      setImagePreview(dataUrl);
      setImageDataUrl(dataUrl);
      // Persist to DB
      try {
        const res = await fetch("/api/media", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataUrl, mimeType: file.type, runId }),
        });
        const data = await res.json();
        if (data.file_path) loadGallery();
      } catch { /* non-fatal */ }
    };
    reader.readAsDataURL(file);
  };

  const selectFromGallery = async (item: MediaItem) => {
    setError(null);
    setImagePreview(item.file_path);
    // Fetch the file → base64 (Odyssey expects raw base64, not URL)
    try {
      const res = await fetch(item.file_path);
      const blob = await res.blob();
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        setImageDataUrl(dataUrl);
      };
      reader.readAsDataURL(blob);
    } catch {
      setError("Failed to load image from gallery");
    }
  };

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/odyssey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `Calming, healing world: ${prompt}`, imageBase64: imageDataUrl }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setVideoUrl(data.videoUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", padding: "32px 24px", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 28 }}>
        <a href={`/dashboard?run_id=${runId}`} style={{ color: "#64748b", fontSize: 14, textDecoration: "none" }}>← Dashboard</a>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>🌊 Memory World</h1>
      </div>

      <p style={{ color: "#64748b", marginBottom: 28, lineHeight: 1.6, maxWidth: 600 }}>
        Describe a calming memory or place, optionally pick a photo from your library or upload a new one (JPEG/PNG), and Prana will generate an immersive video experience tailored to help you relax and restore.
      </p>

      {!videoUrl ? (
        <div className="card" style={{ maxWidth: 600 }}>
          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 13, color: "#64748b", display: "block", marginBottom: 6 }}>Describe your calming memory or place</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 14px", color: "#e2e8f0", fontSize: 14, resize: "vertical" }}
            />
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 13, color: "#64748b", display: "block", marginBottom: 6 }}>Upload a new photo (JPEG/PNG)</label>
            <div
              onClick={() => fileRef.current?.click()}
              style={{ border: "2px dashed var(--border)", borderRadius: 12, padding: 24, textAlign: "center", cursor: "pointer", transition: "border-color 0.2s" }}
            >
              {imagePreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imagePreview} alt="preview" style={{ maxHeight: 160, borderRadius: 8, objectFit: "contain" }} />
              ) : (
                <div style={{ color: "#475569", fontSize: 14 }}>Click to upload JPEG or PNG → Odyssey uses it as a visual seed</div>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png" style={{ display: "none" }} onChange={handleFileChange} />
          </div>

          {gallery.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <label style={{ fontSize: 13, color: "#64748b", display: "block", marginBottom: 8 }}>Or pick from your library ({gallery.length})</label>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8, maxHeight: 240, overflowY: "auto", padding: 4 }}>
                {gallery.map((item) => {
                  const isSelected = imagePreview === item.file_path;
                  return (
                    <div
                      key={item.id}
                      onClick={() => selectFromGallery(item)}
                      style={{
                        position: "relative",
                        aspectRatio: "1",
                        borderRadius: 8,
                        overflow: "hidden",
                        cursor: "pointer",
                        border: isSelected ? "2px solid #22d3ee" : "1px solid var(--border)",
                        transition: "border-color 0.15s",
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={item.file_path} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {error && <div style={{ color: "#f87171", fontSize: 13, marginBottom: 16 }}>{error}</div>}

          <button className="btn-primary" onClick={generate} disabled={loading} style={{ width: "100%", fontSize: 15 }}>
            {loading ? "Generating your world… (~15s)" : "Generate Memory World"}
          </button>

          {loading && (
            <div style={{ marginTop: 16, textAlign: "center", color: "#64748b", fontSize: 13 }}>
              OdysseyML is rendering your immersive experience…
            </div>
          )}
        </div>
      ) : (
        <div>
          <video
            src={videoUrl}
            autoPlay
            loop
            muted={false}
            controls
            style={{ width: "100%", borderRadius: 16, border: "1px solid var(--border)", maxHeight: 520 }}
          />
          <div style={{ marginTop: 20, display: "flex", gap: 12 }}>
            <button className="btn-primary" onClick={() => { setVideoUrl(null); setImageDataUrl(null); setImagePreview(null); }}>
              Generate Another
            </button>
            <a href={videoUrl} download="prana-memory-world.mp4" style={{ padding: "12px 20px", borderRadius: 9999, border: "1px solid var(--border)", color: "#94a3b8", fontSize: 14, textDecoration: "none", cursor: "pointer" }}>
              Download Video
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

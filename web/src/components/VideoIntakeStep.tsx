"use client";

// Optional video-recording step shown on the phone right after voice intake.
// 15s max, 720p/30fps, MediaRecorder with webm-vp9-opus → mp4 fallback.
// Uploads via postIntakeVideo and shows progress states while Twelve Labs
// indexes + queries the clip in the background. The laptop's history-page
// poll surfaces the analysis once it lands.

import { useCallback, useEffect, useRef, useState } from "react";
import { postIntakeVideo } from "@/lib/api";

const MAX_SECONDS = 15;

type Phase =
  | "prompt"          // initial Skip / Record choice
  | "permission"      // requesting camera
  | "recording"       // actively recording with countdown
  | "preview"         // recorded, showing replay + Upload / Retake
  | "uploading"       // POSTing the multipart body
  | "analyzing"       // backend is indexing + querying Twelve Labs
  | "done"            // success
  | "error";          // any failure

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

export function VideoIntakeStep({
  runId,
  onDone,
}: {
  runId: string;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("prompt");
  const [error, setError] = useState<string>("");
  const [secondsLeft, setSecondsLeft] = useState<number>(MAX_SECONDS);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const blobRef = useRef<Blob | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const livePreviewRef = useRef<HTMLVideoElement | null>(null);
  const replayRef = useRef<HTMLVideoElement | null>(null);
  const countdownRef = useRef<number | null>(null);

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (countdownRef.current !== null) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }, []);

  useEffect(() => () => cleanupStream(), [cleanupStream]);
  useEffect(() => {
    // Revoke the object URL when the preview blob changes / component unmounts
    // so we don't leak megabytes of decoded video on retake.
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const startRecording = useCallback(async () => {
    setError("");
    setPhase("permission");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          facingMode: "user",
        },
        audio: true,
      });
      streamRef.current = stream;
      if (livePreviewRef.current) {
        livePreviewRef.current.srcObject = stream;
        await livePreviewRef.current.play().catch(() => {});
      }
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const finalType = mimeType || "video/webm";
        const blob = new Blob(chunksRef.current, { type: finalType });
        blobRef.current = blob;
        const url = URL.createObjectURL(blob);
        setPreviewUrl(url);
        cleanupStream();
        setPhase("preview");
      };
      recorderRef.current = recorder;
      recorder.start();
      setPhase("recording");
      setSecondsLeft(MAX_SECONDS);
      countdownRef.current = window.setInterval(() => {
        setSecondsLeft((s) => {
          if (s <= 1) {
            // Reached zero — stop recording. The interval will be cleared in
            // cleanupStream (called from onstop).
            if (recorderRef.current && recorderRef.current.state === "recording") {
              recorderRef.current.stop();
            }
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    } catch (e) {
      console.error("Camera access failed:", e);
      setError(e instanceof Error ? e.message : "Camera access failed");
      setPhase("error");
      cleanupStream();
    }
  }, [cleanupStream]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
    }
  }, []);

  const retake = useCallback(() => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl("");
    blobRef.current = null;
    chunksRef.current = [];
    setPhase("prompt");
    setError("");
  }, [previewUrl]);

  const upload = useCallback(async () => {
    const blob = blobRef.current;
    if (!blob) return;
    setPhase("uploading");
    setError("");
    try {
      await postIntakeVideo(runId, blob);
      // Backend returns 202 immediately and works the indexing pipeline in the
      // background. Show the analyzing state so the user knows the upload
      // landed; the laptop will surface the actual analysis when ready.
      setPhase("analyzing");
      // Give the user a moment to read the message, then close the step. We
      // don't poll the full 2 minutes here — laptop history does that.
      window.setTimeout(() => setPhase("done"), 1200);
    } catch (e) {
      console.error("Video upload failed:", e);
      setError(e instanceof Error ? e.message : "Upload failed");
      setPhase("error");
    }
  }, [runId]);

  return (
    <div className="flex flex-col min-h-screen bg-[#F4F1EA] items-center justify-center px-6 py-8">
      <div className="w-full max-w-md flex flex-col items-center gap-6">

        {phase === "prompt" && (
          <>
            <h2 className="font-serif text-[#1F3A2E] text-2xl text-center">
              Add a video?
            </h2>
            <p className="text-[#3D3D3D] text-base text-center leading-relaxed">
              Optional. Record up to 15 seconds showing what you&apos;re experiencing
              — a rash, a sore area, the way something looks. We&apos;ll add it to
              your intake on the laptop.
            </p>
            <button
              onClick={startRecording}
              className="w-full bg-[#1F3A2E] text-white rounded-full font-medium text-lg min-h-[56px] hover:bg-[#2A4D3D] transition-colors"
            >
              🎥 Record video
            </button>
            <button
              onClick={onDone}
              className="text-[#3D3D3D] text-sm underline underline-offset-2 hover:text-[#1F3A2E] py-3 min-h-[44px]"
            >
              Skip
            </button>
          </>
        )}

        {phase === "permission" && (
          <p className="text-[#3D3D3D] text-base">Requesting camera…</p>
        )}

        {(phase === "recording") && (
          <>
            <video
              ref={livePreviewRef}
              autoPlay
              playsInline
              muted
              className="w-full aspect-[3/4] rounded-2xl bg-black object-cover"
            />
            <div className="flex items-center gap-3 text-[#1F3A2E] font-mono text-lg">
              <span className="w-2 h-2 rounded-full bg-red-600 animate-pulse" />
              <span>Recording — {secondsLeft}s left</span>
            </div>
            <button
              onClick={stopRecording}
              className="w-full bg-red-600 text-white rounded-full font-medium text-lg min-h-[56px] hover:bg-red-700 transition-colors"
            >
              Stop
            </button>
          </>
        )}

        {phase === "preview" && (
          <>
            <video
              ref={replayRef}
              src={previewUrl}
              controls
              playsInline
              className="w-full aspect-[3/4] rounded-2xl bg-black object-cover"
            />
            <button
              onClick={upload}
              className="w-full bg-[#1F3A2E] text-white rounded-full font-medium text-lg min-h-[56px] hover:bg-[#2A4D3D] transition-colors"
            >
              Upload
            </button>
            <button
              onClick={retake}
              className="text-[#3D3D3D] text-sm underline underline-offset-2 hover:text-[#1F3A2E] py-3 min-h-[44px]"
            >
              Retake
            </button>
          </>
        )}

        {phase === "uploading" && (
          <p className="text-[#3D3D3D] text-base animate-pulse">Uploading…</p>
        )}

        {phase === "analyzing" && (
          <p className="text-[#3D3D3D] text-base text-center leading-relaxed animate-pulse">
            Analyzing video… (this can take up to 2 minutes)
          </p>
        )}

        {phase === "done" && (
          <>
            <p className="font-serif text-[#1F3A2E] text-xl text-center">
              Done — results are on your laptop
            </p>
            <button
              onClick={onDone}
              className="w-full bg-[#1F3A2E] text-white rounded-full font-medium text-lg min-h-[56px] hover:bg-[#2A4D3D] transition-colors"
            >
              Continue
            </button>
          </>
        )}

        {phase === "error" && (
          <>
            <p className="text-red-700 text-base text-center">{error || "Something went wrong."}</p>
            <button
              onClick={retake}
              className="w-full bg-[#1F3A2E] text-white rounded-full font-medium text-lg min-h-[56px] hover:bg-[#2A4D3D] transition-colors"
            >
              Try again
            </button>
            <button
              onClick={onDone}
              className="text-[#3D3D3D] text-sm underline underline-offset-2 hover:text-[#1F3A2E] py-3 min-h-[44px]"
            >
              Skip
            </button>
          </>
        )}
      </div>
    </div>
  );
}

import { NextRequest, NextResponse } from "next/server";
import { Odyssey } from "@odysseyml/odyssey";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

export const maxDuration = 120;

const RESULTS_DIR = path.join(process.cwd(), "public", "generated");

export async function POST(req: NextRequest) {
  try {
    const { prompt, imageBase64 } = (await req.json()) as {
      prompt?: string;
      imageBase64?: string;
    };

    if (!imageBase64 && !prompt?.trim()) {
      return NextResponse.json({ error: "Image or prompt is required" }, { status: 400 });
    }

    if (!process.env.ODYSSEY_API_KEY) {
      return NextResponse.json({ error: "ODYSSEY_API_KEY not configured" }, { status: 500 });
    }

    const client = new Odyssey({ apiKey: process.env.ODYSSEY_API_KEY });

    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const jobDir = path.join(RESULTS_DIR, jobId);
    await mkdir(jobDir, { recursive: true });

    const startAction: { prompt: string; image?: string } = {
      prompt: prompt?.trim() || "A calming natural landscape for wellness and healing",
    };
    if (imageBase64) {
      // Odyssey requires a full data URL: data:<mime>;base64,<data>
      startAction.image = imageBase64.startsWith("data:")
        ? imageBase64
        : `data:image/jpeg;base64,${imageBase64}`;
    }

    const job = await client.simulate({
      script: [
        { timestamp_ms: 0, start: startAction },
        { timestamp_ms: 4000, end: {} },
      ],
      portrait: false,
    });

    let status: Awaited<ReturnType<typeof client.getSimulateStatus>>;
    while (true) {
      await new Promise((r) => setTimeout(r, 1500));
      status = await client.getSimulateStatus(job.job_id);
      if (status.status === "completed") break;
      if (status.status === "failed" || status.status === "cancelled") {
        return NextResponse.json({ error: `Simulation ${status.status}` }, { status: 500 });
      }
    }

    if (!status.streams?.length) {
      return NextResponse.json({ error: "No streams returned" }, { status: 500 });
    }

    const recording = await client.getRecording(status.streams[0].stream_id);
    const videoRes = await fetch(recording.video_url!);
    if (!videoRes.ok) {
      return NextResponse.json({ error: "Failed to download video" }, { status: 500 });
    }

    const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
    await writeFile(path.join(jobDir, "odyssey.mp4"), videoBuffer);

    return NextResponse.json({ videoUrl: `/generated/${jobId}/odyssey.mp4`, jobId });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

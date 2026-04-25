import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { getDb } from "@/lib/db";

export const maxDuration = 30;

const UPLOADS_DIR = path.join(process.cwd(), "public", "uploads");

const ALLOWED = new Set(["image/jpeg", "image/png"]);

export async function POST(req: NextRequest) {
  const { dataUrl, mimeType, runId } = (await req.json()) as {
    dataUrl?: string;
    mimeType?: string;
    runId?: string;
  };
  if (!dataUrl) return NextResponse.json({ error: "dataUrl required" }, { status: 400 });

  const detectedMime = mimeType ?? dataUrl.match(/^data:([^;]+);/)?.[1] ?? "";
  if (!ALLOWED.has(detectedMime)) {
    return NextResponse.json({ error: "Only JPEG/PNG allowed" }, { status: 400 });
  }

  const base64 = dataUrl.split(",")[1] ?? "";
  const buffer = Buffer.from(base64, "base64");
  await mkdir(UPLOADS_DIR, { recursive: true });

  const ext = detectedMime === "image/png" ? "png" : "jpg";
  const filename = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await writeFile(path.join(UPLOADS_DIR, filename), buffer);

  const filePath = `/uploads/${filename}`;
  const db = getDb();
  const result = db
    .prepare("INSERT INTO media (run_id, file_path, kind) VALUES (?, ?, 'image')")
    .run(runId ?? null, filePath);

  return NextResponse.json({ id: result.lastInsertRowid, file_path: filePath });
}

export async function GET() {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, run_id, file_path, created_at FROM media WHERE kind = 'image' ORDER BY created_at DESC LIMIT 50")
    .all();
  return NextResponse.json({ items: rows });
}

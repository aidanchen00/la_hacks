import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const audioFile = formData.get("audio") as File;

  if (!audioFile) {
    return NextResponse.json({ error: "No audio provided" }, { status: 400 });
  }

  const params = new URLSearchParams({ model: "nova-3", smart_format: "true" });
  const audioBuffer = await audioFile.arrayBuffer();

  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": audioFile.type || "audio/webm",
    },
    body: audioBuffer,
  });

  if (!res.ok) {
    const err = await res.text();
    return NextResponse.json({ error: err }, { status: res.status });
  }

  const data = await res.json();
  const alternative = data.results?.channels?.[0]?.alternatives?.[0];
  const transcript = alternative?.transcript ?? "";
  return NextResponse.json({ transcript });
}

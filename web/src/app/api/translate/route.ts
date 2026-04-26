import { NextResponse } from "next/server";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type Lang = "en" | "es" | "zh";

const LANG_INSTRUCTIONS: Record<Lang, string> = {
  en: "English",
  es: "Spanish (Español)",
  zh: "Simplified Chinese (中文)",
};

// Process-level cache so repeated /api/translate hits for the same string
// don't re-bill OpenAI. Keyed on `${target}:${text}`.
const cache = new Map<string, string>();
const MAX_CACHE = 2000;

function cacheGet(key: string): string | undefined {
  const v = cache.get(key);
  if (v !== undefined) {
    // LRU-ish: refresh recency
    cache.delete(key);
    cache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, value: string): void {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

export async function POST(req: Request) {
  try {
    const { texts, target } = (await req.json()) as { texts: string[]; target: Lang };

    if (!Array.isArray(texts) || !texts.length) {
      return NextResponse.json({ translations: [] });
    }

    const lang = (["en", "es", "zh"] as Lang[]).includes(target) ? target : "en";

    // No-op for English — saves a round-trip and avoids OpenAI mangling already-English text.
    if (lang === "en") {
      return NextResponse.json({ translations: texts });
    }

    // Cache lookup first
    const results: (string | null)[] = texts.map((t) => cacheGet(`${lang}:${t}`) ?? null);
    const missingIdx = results.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);

    if (missingIdx.length === 0) {
      return NextResponse.json({ translations: results as string[] });
    }

    // One LLM call for everything missing — JSON in, JSON out.
    const missingTexts = missingIdx.map((i) => texts[i]);
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `Translate each input string to ${LANG_INSTRUCTIONS[lang]}. ` +
            `Preserve formatting, line breaks, emojis, and any URLs or numbers exactly. ` +
            `Do NOT translate proper nouns like "Prana", "CVS", "Walgreens", "GoodRx", "Healthgrades", "Solv", "Stripe". ` +
            `Return JSON of the form {"translations":[...]} with one translation per input in the same order.`,
        },
        {
          role: "user",
          content: JSON.stringify({ inputs: missingTexts }),
        },
      ],
      temperature: 0,
      max_tokens: 1500,
    });

    const raw = completion.choices[0].message.content ?? "{}";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    const translations = (parsed as { translations?: unknown }).translations;
    const arr = Array.isArray(translations) ? (translations as unknown[]) : [];

    missingIdx.forEach((origIdx, j) => {
      const translated = typeof arr[j] === "string" ? (arr[j] as string) : texts[origIdx];
      results[origIdx] = translated;
      cacheSet(`${lang}:${texts[origIdx]}`, translated);
    });

    return NextResponse.json({ translations: results as string[] });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

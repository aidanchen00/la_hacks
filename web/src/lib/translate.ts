"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getLang, subscribeLang, type Lang } from "@/lib/language";

const CACHE_PREFIX = "prana.t.";  // localStorage key: prana.t.{lang}:{hash}

function readCache(lang: Lang, text: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(`${CACHE_PREFIX}${lang}:${text}`);
  } catch {
    return null;
  }
}

function writeCache(lang: Lang, text: string, translated: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(`${CACHE_PREFIX}${lang}:${text}`, translated);
  } catch {
    // localStorage full or unavailable — silently skip; the in-memory cache
    // on the API route will still spare us the LLM hit.
  }
}

async function fetchTranslations(texts: string[], target: Lang): Promise<string[]> {
  const res = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts, target }),
  });
  if (!res.ok) throw new Error(`translate ${res.status}`);
  const data = (await res.json()) as { translations: string[] };
  return data.translations ?? texts;
}

/**
 * Translate a batch of English strings into the user's current language.
 *
 * - Returns the originals immediately on the first render and once when lang
 *   changes; resolves to translations once the network returns.
 * - English is a no-op.
 * - Re-runs whenever the language changes (subscribed via subscribeLang).
 * - Empty / falsy entries pass through untouched.
 */
export function useTranslate(texts: (string | null | undefined)[]): string[] {
  const [lang, setLang] = useState<Lang>("en");
  const [translated, setTranslated] = useState<string[]>(() => texts.map((t) => t ?? ""));
  // Re-trigger when the *content* of texts changes — JSON.stringify is fine
  // for the small per-page batches we send.
  const key = useMemo(() => JSON.stringify(texts), [texts]);
  const reqIdRef = useRef(0);

  useEffect(() => {
    setLang(getLang());
    return subscribeLang((l) => setLang(l));
  }, []);

  useEffect(() => {
    const myReqId = ++reqIdRef.current;
    const inputs: string[] = texts.map((t) => t ?? "");

    if (lang === "en") {
      setTranslated(inputs);
      return;
    }

    // Resolve each entry from cache first; only network-fetch the misses.
    const resolved: string[] = inputs.map((t) => {
      if (!t) return t;
      const cached = readCache(lang, t);
      return cached ?? t;
    });
    setTranslated(resolved);

    const missing: { idx: number; text: string }[] = [];
    inputs.forEach((t, i) => {
      if (t && readCache(lang, t) === null) missing.push({ idx: i, text: t });
    });
    if (!missing.length) return;

    fetchTranslations(missing.map((m) => m.text), lang)
      .then((out) => {
        if (reqIdRef.current !== myReqId) return; // language changed mid-flight
        const next = [...resolved];
        missing.forEach((m, j) => {
          const t = out[j] ?? m.text;
          next[m.idx] = t;
          writeCache(lang, m.text, t);
        });
        setTranslated(next);
      })
      .catch(() => { /* fall back to originals already shown */ });
  // `key` already reflects texts; spreading texts as deps would refetch every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, key]);

  return translated;
}

/** Convenience for a single string. */
export function useTranslated(text: string | null | undefined): string {
  return useTranslate([text])[0] ?? (text ?? "");
}

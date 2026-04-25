"use client";

import { useEffect, useRef, useState } from "react";
import { Lang, LANG_LABELS, LANG_NAMES, getLang, setLang, subscribeLang } from "@/lib/language";

interface Props {
  /** Optional: notify parent when language changes */
  onChange?: (lang: Lang) => void;
  /** Optional className for the trigger button (overrides default styling). */
  className?: string;
}

export default function LanguagePicker({ onChange, className }: Props) {
  const [lang, setLangState] = useState<Lang>("en");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLangState(getLang());
    return subscribeLang((l) => setLangState(l));
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const choose = (l: Lang) => {
    setLang(l);
    setLangState(l);
    setOpen(false);
    onChange?.(l);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Select language"
        className={
          className ??
          "flex items-center gap-1.5 px-3 py-2 rounded-full border border-[#1F3A2E]/20 text-[#3D3D3D] text-xs sm:text-sm hover:border-[#1F3A2E]/40 transition-colors min-h-[36px] bg-white/60 backdrop-blur-sm"
        }
        type="button"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        <span>{LANG_LABELS[lang]}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-white rounded-xl border border-[#1F3A2E]/10 shadow-lg py-1 z-50 min-w-[140px]">
          {(["en", "es", "zh"] as Lang[]).map((l) => (
            <button
              key={l}
              onClick={() => choose(l)}
              type="button"
              className={`w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-[#F4F1EA] flex items-center justify-between ${
                lang === l ? "text-[#1F3A2E] font-semibold" : "text-[#3D3D3D]"
              }`}
            >
              <span>{LANG_NAMES[l]}</span>
              <span className="text-xs text-[#6B7280]">{LANG_LABELS[l]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

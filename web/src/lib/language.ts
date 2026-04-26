export type Lang = "en" | "es" | "zh";

export const LANG_LABELS: Record<Lang, string> = { en: "EN", es: "ES", zh: "中文" };
export const LANG_NAMES: Record<Lang, string> = { en: "English", es: "Español", zh: "中文" };

const STORAGE_KEY = "prana.lang";
const EVENT_NAME = "prana:lang-changed";

export function getLang(): Lang {
  if (typeof window === "undefined") return "en";
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "es" || v === "zh" ? v : "en";
}

export function setLang(lang: Lang): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, lang);
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: lang }));
}

export function subscribeLang(cb: (lang: Lang) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => cb((e as CustomEvent).detail as Lang);
  const storage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY && (e.newValue === "en" || e.newValue === "es" || e.newValue === "zh")) {
      cb(e.newValue as Lang);
    }
  };
  window.addEventListener(EVENT_NAME, handler);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(EVENT_NAME, handler);
    window.removeEventListener("storage", storage);
  };
}

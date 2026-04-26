"use client";

/**
 * Anonymous-but-persistent login keyed on the World ID nullifier hash.
 *
 * - `prana.nullifier` (localStorage) — durable across sessions; powers the
 *   /profile page so the user can come back later and find their data.
 * - `prana_verified` (sessionStorage) — short-lived per-tab gate already used
 *   by the home/intake flow; we keep writing it for backwards compat.
 *
 * Querying never requires login: the home page still works with no stored
 * hash. A stored hash only unlocks the profile + deductible features.
 */

const KEY = "prana.nullifier";
const SESSION_KEY = "prana_verified";  // legacy compat
const EVENT = "prana:nullifier-changed";

export function getStoredNullifier(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(KEY) || sessionStorage.getItem(SESSION_KEY) || null;
}

export function setStoredNullifier(hash: string): void {
  if (typeof window === "undefined" || !hash) return;
  localStorage.setItem(KEY, hash);
  sessionStorage.setItem(SESSION_KEY, hash);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: hash }));
}

export function clearStoredNullifier(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY);
  sessionStorage.removeItem(SESSION_KEY);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: null }));
}

export function subscribeNullifier(cb: (hash: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => cb((e as CustomEvent).detail as string | null);
  const storage = (e: StorageEvent) => {
    if (e.key === KEY) cb(e.newValue || null);
  };
  window.addEventListener(EVENT, handler);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(EVENT, handler);
    window.removeEventListener("storage", storage);
  };
}

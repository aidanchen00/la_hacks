export interface Memory {
  id: string;
  title: string;
  /** Either a remote URL (seed) or a data URL (uploaded) */
  src: string;
  /** True if this is a built-in seed memory */
  seed?: boolean;
  /** Optional user-provided custom prompt for this memory */
  customPrompt?: string;
  createdAt: number;
}

/** General prompt — keeps generation guided by the image, not the words */
export const DEFAULT_MEMORY_PROMPT =
  "Bring this scene gently to life — soft natural motion, calming light, peaceful and immersive.";

/**
 * Seed library of serene nature photos (Unsplash, free to use).
 * These are remote URLs so we don't bloat the bundle. They're fetched
 * via the /api/memories/proxy route to convert to a data URL for Odyssey.
 */
export const SEED_MEMORIES: Memory[] = [
  {
    id: "seed-forest",
    title: "Misty Forest",
    src: "https://images.unsplash.com/photo-1448375240586-882707db888b?w=1200&q=80",
    seed: true,
    createdAt: 0,
  },
  {
    id: "seed-beach",
    title: "Golden Hour Beach",
    src: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1200&q=80",
    seed: true,
    createdAt: 0,
  },
  {
    id: "seed-lake",
    title: "Mountain Lake",
    src: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1200&q=80",
    seed: true,
    createdAt: 0,
  },
  {
    id: "seed-meadow",
    title: "Sunset Meadow",
    src: "https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=1200&q=80",
    seed: true,
    createdAt: 0,
  },
  {
    id: "seed-waterfall",
    title: "Quiet Waterfall",
    src: "https://images.unsplash.com/photo-1432405972618-c60b0225b8f9?w=1200&q=80",
    seed: true,
    createdAt: 0,
  },
  {
    id: "seed-redwoods",
    title: "Tall Redwoods",
    src: "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1200&q=80",
    seed: true,
    createdAt: 0,
  },
];

const STORAGE_KEY = "prana.memory_library.v1";

export function loadUserMemories(): Memory[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveUserMemories(memories: Memory[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(memories));
  } catch (e) {
    // localStorage quota exceeded — most likely cause
    console.warn("[memories] save failed:", e);
  }
}

export function addMemory(memory: Memory): Memory[] {
  const current = loadUserMemories();
  const next = [memory, ...current];
  saveUserMemories(next);
  return next;
}

export function removeMemory(id: string): Memory[] {
  const next = loadUserMemories().filter((m) => m.id !== id);
  saveUserMemories(next);
  return next;
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl: string, filename = "memory.jpg"): File {
  const [meta, b64] = dataUrl.split(",");
  const mimeMatch = /data:([^;]+)/.exec(meta);
  const mime = mimeMatch?.[1] ?? "image/jpeg";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], filename, { type: mime });
}

/** Resolve any memory src (remote URL or data URL) into a File Odyssey can consume */
export async function resolveMemorySrc(src: string): Promise<File> {
  if (src.startsWith("data:")) return dataUrlToFile(src);
  const res = await fetch(`/api/memories/proxy?url=${encodeURIComponent(src)}`);
  if (!res.ok) throw new Error(`Failed to fetch memory image (${res.status})`);
  const data = await res.json();
  return dataUrlToFile(data.dataUrl as string);
}

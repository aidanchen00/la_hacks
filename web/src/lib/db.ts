import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "..", "prana.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      voice_room TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS symptoms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT,
      mention_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS conditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      related_symptom_ids TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS user_symptoms (
      user_id INTEGER NOT NULL,
      symptom_id INTEGER NOT NULL,
      session_id INTEGER,
      mention_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, symptom_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (symptom_id) REFERENCES symptoms(id)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      instruction TEXT,
      intake_summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS routing_decisions (
      run_id TEXT PRIMARY KEY,
      urgency TEXT NOT NULL DEFAULT 'wellness',
      recommended_path TEXT NOT NULL DEFAULT 'self_care',
      summary TEXT,
      next_actions TEXT NOT NULL DEFAULT '[]',
      payment_required INTEGER NOT NULL DEFAULT 0,
      payment_amount REAL NOT NULL DEFAULT 0,
      requires_doctor_approval INTEGER NOT NULL DEFAULT 0,
      rationale TEXT,
      disclaimers TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES runs(id)
    );

    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      agent_name TEXT,
      event_type TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
      run_id TEXT PRIMARY KEY,
      stripe_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      amount REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      run_id TEXT,
      file_path TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'image',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations(session_id);
    CREATE INDEX IF NOT EXISTS idx_user_symptoms_user ON user_symptoms(user_id);
    CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_events(run_id);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
  `);
}

// ---------------------------------------------------------------------------
// Run helpers
// ---------------------------------------------------------------------------

export interface RunRow {
  id: string;
  user_id: number | null;
  status: string;
  instruction: string | null;
  intake_summary: string | null;
  created_at: string;
}

export function insertRun(id: string, instruction: string, intakeSummary?: string): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO runs (id, instruction, intake_summary, status) VALUES (?, ?, ?, 'pending')"
    )
    .run(id, instruction, intakeSummary ?? null);
}

export function updateRunStatus(id: string, status: string): void {
  getDb()
    .prepare("UPDATE runs SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, id);
}

export function getRun(id: string): RunRow | undefined {
  return getDb().prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
}

// ---------------------------------------------------------------------------
// RoutingDecision helpers
// ---------------------------------------------------------------------------

export interface RoutingDecisionRow {
  run_id: string;
  urgency: string;
  recommended_path: string;
  summary: string | null;
  next_actions: string;
  payment_required: number;
  payment_amount: number;
  requires_doctor_approval: number;
  rationale: string | null;
  disclaimers: string;
}

export function upsertRoutingDecision(d: RoutingDecisionRow): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO routing_decisions
       (run_id, urgency, recommended_path, summary, next_actions, payment_required,
        payment_amount, requires_doctor_approval, rationale, disclaimers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      d.run_id, d.urgency, d.recommended_path, d.summary ?? null,
      d.next_actions, d.payment_required, d.payment_amount,
      d.requires_doctor_approval, d.rationale ?? null, d.disclaimers
    );
}

export function getRoutingDecision(runId: string): RoutingDecisionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM routing_decisions WHERE run_id = ?")
    .get(runId) as RoutingDecisionRow | undefined;
}

// ---------------------------------------------------------------------------
// Symptom helpers
// ---------------------------------------------------------------------------

export function upsertSymptom(name: string, category?: string): number {
  const existing = getDb()
    .prepare("SELECT id FROM symptoms WHERE name = ?")
    .get(name) as { id: number } | undefined;
  if (existing) {
    getDb()
      .prepare("UPDATE symptoms SET mention_count = mention_count + 1 WHERE id = ?")
      .run(existing.id);
    return existing.id;
  }
  const res = getDb()
    .prepare("INSERT INTO symptoms (name, category) VALUES (?, ?)")
    .run(name, category ?? "general");
  return Number(res.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Agent event helpers
// ---------------------------------------------------------------------------

export function insertAgentEvent(runId: string, agentName: string, eventType: string, payload: object): void {
  getDb()
    .prepare(
      "INSERT INTO agent_events (run_id, agent_name, event_type, payload) VALUES (?, ?, ?, ?)"
    )
    .run(runId, agentName, eventType, JSON.stringify(payload));
}

export function getAgentEvents(runId: string, since?: number): unknown[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_events WHERE run_id = ? ORDER BY id ASC")
    .all(runId);
  return since !== undefined ? rows.slice(since) : rows;
}

// ---------------------------------------------------------------------------
// Recent runs listing
// ---------------------------------------------------------------------------

export interface RunSummary {
  id: string;
  status: string;
  instruction: string | null;
  intake_summary: string | null;
  created_at: string;
  urgency: string | null;
  recommended_path: string | null;
  rd_summary: string | null;
}

export function getRecentRuns(limit = 200): RunSummary[] {
  // Only return runs that have been classified (have a routing_decision row).
  return getDb().prepare(`
    SELECT r.id, r.status, r.instruction, r.intake_summary, r.created_at,
           rd.urgency, rd.recommended_path, rd.summary AS rd_summary
    FROM runs r
    INNER JOIN routing_decisions rd ON rd.run_id = r.id
    ORDER BY r.created_at DESC
    LIMIT ?
  `).all(limit) as RunSummary[];
}

// ---------------------------------------------------------------------------
// Knowledge Graph query
// ---------------------------------------------------------------------------

export interface KGNode {
  id: string;
  name: string;
  type: string;
  val?: number;
  description?: string;
  meta?: Record<string, string | number | undefined>;
}

export interface KGData {
  nodes: KGNode[];
  links: { source: string; target: string; weight?: number }[];
}

export function buildKGData(): KGData {
  const db = getDb();
  const links: KGData["links"] = [];
  const nodeMap = new Map<string, KGNode>();

  const addNode = (n: KGNode) => {
    if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
  };

  // 1. Real intake runs — the only "session"-type node from now on.
  //    Limit to runs from 2026-04-24 onward; drop any run that produced no
  //    summary at all (so the graph isn't polluted with empty placeholders).
  const rawRuns = db.prepare(`
    SELECT r.id, r.user_id, r.created_at, r.instruction, r.intake_summary,
           rd.urgency, rd.recommended_path, rd.summary AS rd_summary
    FROM runs r
    LEFT JOIN routing_decisions rd ON rd.run_id = r.id
    WHERE r.created_at >= '2026-04-24'
    ORDER BY r.created_at DESC LIMIT 30
  `).all() as {
    id: string; user_id: number | null; created_at: string;
    instruction: string | null; intake_summary: string | null;
    urgency: string | null; recommended_path: string | null;
    rd_summary: string | null;
  }[];

  const runs = rawRuns.filter((r) => {
    const sum = (r.rd_summary ?? r.intake_summary ?? "").trim();
    return sum.length > 0;
  });

  for (const r of runs) {
    const date = r.created_at.slice(5, 10);
    const path = (r.recommended_path ?? "intake").replace(/_/g, " ");
    const sumText = (r.rd_summary ?? r.intake_summary ?? "").trim();
    const description = sumText.length > 220 ? sumText.slice(0, 220) + "…" : sumText;
    addNode({
      id: `run-${r.id}`,
      name: `${path} · ${date}`,
      type: "session",
      val: 4,
      description,
      meta: {
        urgency: r.urgency ?? "wellness",
        path,
        date: r.created_at.slice(0, 10),
      },
    });
  }

  // 2. Symptoms — pull every user_symptoms row, link to all of that user's runs.
  const userSymptoms = db.prepare(`
    SELECT us.user_id, us.symptom_id, us.session_id, us.mention_count AS user_count,
           s.name AS sym_name, s.category AS sym_category, s.mention_count AS global_count
    FROM user_symptoms us
    JOIN symptoms s ON s.id = us.symptom_id
    LIMIT 200
  `).all() as {
    user_id: number; symptom_id: number; session_id: number | null;
    user_count: number; sym_name: string; sym_category: string | null; global_count: number;
  }[];

  // Build user_id → list of run_ids map (chronological)
  const userRuns = new Map<number, { id: string; created_at: string }[]>();
  for (const r of runs) {
    if (r.user_id == null) continue;
    if (!userRuns.has(r.user_id)) userRuns.set(r.user_id, []);
    userRuns.get(r.user_id)!.push({ id: r.id, created_at: r.created_at });
  }

  const symptomToRuns = new Map<number, Set<string>>();
  for (const us of userSymptoms) {
    const symId = `symptom-${us.symptom_id}`;
    addNode({
      id: symId,
      name: us.sym_name,
      type: "symptom",
      val: Math.max(2, Math.min(5, Math.ceil(us.global_count / 2))),
      description: `${us.sym_category ? us.sym_category[0].toUpperCase() + us.sym_category.slice(1) + " symptom. " : ""}Reported ${us.user_count} time${us.user_count === 1 ? "" : "s"} by this user; ${us.global_count} mention${us.global_count === 1 ? "" : "s"} across all users.`,
      meta: {
        category: us.sym_category ?? "general",
        userCount: us.user_count,
        globalCount: us.global_count,
      },
    });
    // Link to every run owned by this user
    const runsForUser = userRuns.get(us.user_id) ?? [];
    if (!symptomToRuns.has(us.symptom_id)) symptomToRuns.set(us.symptom_id, new Set());
    for (const r of runsForUser) {
      links.push({ source: `run-${r.id}`, target: symId, weight: 1 });
      symptomToRuns.get(us.symptom_id)!.add(r.id);
    }
  }

  // 3. Conditions linked to symptoms already in graph
  const conditions = db.prepare("SELECT id, name, related_symptom_ids FROM conditions LIMIT 30").all() as { id: number; name: string; related_symptom_ids: string }[];
  for (const c of conditions) {
    let relIds: number[] = [];
    try { relIds = JSON.parse(c.related_symptom_ids); } catch { /* empty */ }
    const linkedSymptoms = relIds.filter(sid => nodeMap.has(`symptom-${sid}`));
    if (linkedSymptoms.length === 0) continue;
    addNode({
      id: `condition-${c.id}`,
      name: c.name,
      type: "condition",
      val: 3,
      description: `Possible underlying condition. Connected to ${linkedSymptoms.length} symptom${linkedSymptoms.length === 1 ? "" : "s"} in your graph.`,
      meta: { linkedSymptoms: linkedSymptoms.length },
    });
    for (const sid of linkedSymptoms) {
      links.push({ source: `condition-${c.id}`, target: `symptom-${sid}`, weight: 1 });
    }
  }

  // 3b. Bridge real intake runs to symptom nodes by scanning each run's
  //     instruction + summary text for known symptom names. Most real runs
  //     have user_id=NULL so the join above doesn't link them; this catches
  //     the "headache, fever, anxiety" mentions and wires them into the mix.
  const symptomNameToId = new Map<string, number>();
  for (const us of userSymptoms) {
    symptomNameToId.set(us.sym_name.toLowerCase(), us.symptom_id);
  }
  // Also include any symptoms not yet pulled (for matching only — they'll
  // become nodes if mentioned).
  const allSymptoms = db.prepare("SELECT id, name, category, mention_count FROM symptoms").all() as { id: number; name: string; category: string | null; mention_count: number }[];
  const symMeta = new Map<number, { name: string; category: string | null; mention_count: number }>();
  for (const s of allSymptoms) {
    symptomNameToId.set(s.name.toLowerCase(), s.id);
    symMeta.set(s.id, s);
  }

  for (const r of runs) {
    const haystack = [r.instruction, r.intake_summary, r.rd_summary]
      .filter(Boolean).join(" ").toLowerCase();
    if (!haystack) continue;
    const matched = new Set<number>();
    for (const [name, id] of symptomNameToId) {
      // word-boundary-ish match to avoid e.g. "ache" inside "headache" matching "ache"
      const re = new RegExp(`(^|[^a-z])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
      if (re.test(haystack)) matched.add(id);
    }
    for (const sid of matched) {
      const symId = `symptom-${sid}`;
      if (!nodeMap.has(symId)) {
        const m = symMeta.get(sid);
        if (m) {
          addNode({
            id: symId,
            name: m.name,
            type: "symptom",
            val: Math.max(2, Math.min(5, Math.ceil(m.mention_count / 2))),
            description: `${m.category ? m.category[0].toUpperCase() + m.category.slice(1) + " symptom. " : ""}${m.mention_count} mention${m.mention_count === 1 ? "" : "s"} across all users.`,
            meta: { category: m.category ?? "general", globalCount: m.mention_count },
          });
        }
      }
      links.push({ source: `run-${r.id}`, target: symId, weight: 1 });
    }
  }

  // 4. Run → condition edges (match recommended_path against condition name)
  const conditionsInGraph = [...nodeMap.values()].filter(n => n.type === "condition");
  for (const r of runs) {
    const path = (r.recommended_path ?? "").replace(/_/g, " ").toLowerCase();
    for (const cnode of conditionsInGraph) {
      const cname = cnode.name.toLowerCase();
      if (cname.includes(path) || path.split(" ").some(w => w.length > 4 && cname.includes(w))) {
        links.push({ source: `run-${r.id}`, target: cnode.id, weight: 2 });
        break;
      }
    }
  }

  // 5. Safety net: any run that still has zero links gets connected to the
  //    most-recent run that does have links, so nothing floats off-screen.
  const linkedSet = new Set<string>();
  for (const l of links) {
    linkedSet.add(typeof l.source === "string" ? l.source : (l.source as { id: string }).id);
    linkedSet.add(typeof l.target === "string" ? l.target : (l.target as { id: string }).id);
  }
  const orphanRuns = runs.filter(r => !linkedSet.has(`run-${r.id}`));
  const anchor = runs.find(r => linkedSet.has(`run-${r.id}`));
  if (anchor) {
    for (const r of orphanRuns) {
      links.push({ source: `run-${r.id}`, target: `run-${anchor.id}`, weight: 0.5 });
    }
  }

  return { nodes: [...nodeMap.values()], links };
}

import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "..", "careflow.db");

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
      nullifier_hash TEXT,
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

  // Migrate: add nullifier_hash if not present (existing DBs)
  try { db.exec("ALTER TABLE runs ADD COLUMN nullifier_hash TEXT"); } catch { /* already exists */ }
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

export function insertRun(id: string, instruction: string, intakeSummary?: string, nullifierHash?: string): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO runs (id, instruction, intake_summary, nullifier_hash, status) VALUES (?, ?, ?, ?, 'pending')"
    )
    .run(id, instruction, intakeSummary ?? null, nullifierHash ?? null);
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

export function getRecentRuns(limit = 20): RunSummary[] {
  return getDb().prepare(`
    SELECT r.id, r.status, r.instruction, r.intake_summary, r.created_at,
           rd.urgency, rd.recommended_path, rd.summary AS rd_summary
    FROM runs r
    LEFT JOIN routing_decisions rd ON rd.run_id = r.id
    ORDER BY r.created_at DESC
    LIMIT ?
  `).all(limit) as RunSummary[];
}

// ---------------------------------------------------------------------------
// Knowledge Graph query
// ---------------------------------------------------------------------------

export interface KGData {
  nodes: { id: string; name: string; type: string; val?: number }[];
  links: { source: string; target: string; weight?: number }[];
}

export function buildKGData(): KGData {
  const db = getDb();
  const links: KGData["links"] = [];
  const nodeSet = new Set<string>();
  const nodeMap = new Map<string, KGData["nodes"][0]>();

  const addNode = (n: KGData["nodes"][0]) => {
    if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
    nodeSet.add(n.id);
  };

  // 1. Intake runs (navigable — clicking goes to dashboard)
  const runs = db.prepare(`
    SELECT r.id, r.created_at, rd.urgency, rd.recommended_path
    FROM runs r
    INNER JOIN routing_decisions rd ON rd.run_id = r.id
    ORDER BY r.created_at DESC LIMIT 12
  `).all() as { id: string; created_at: string; urgency: string; recommended_path: string }[];

  for (const r of runs) {
    const date = r.created_at.slice(5, 10);
    addNode({ id: `run-${r.id}`, name: `${(r.recommended_path ?? "intake").replace(/_/g, " ")} · ${date}`, type: "session", val: 4 });
  }

  // 2. Voice sessions linked to symptoms
  const userSymptoms = db.prepare(`
    SELECT us.session_id, us.symptom_id, s.name AS sym_name, s.mention_count
    FROM user_symptoms us
    JOIN symptoms s ON s.id = us.symptom_id
    WHERE us.session_id IS NOT NULL
    LIMIT 120
  `).all() as { session_id: number; symptom_id: number; sym_name: string; mention_count: number }[];

  const sessionIds = [...new Set(userSymptoms.map(u => u.session_id))];
  for (const sid of sessionIds) {
    addNode({ id: `session-${sid}`, name: `Session ${sid}`, type: "session", val: 3 });
  }
  for (const us of userSymptoms) {
    addNode({ id: `symptom-${us.symptom_id}`, name: us.sym_name, type: "symptom", val: Math.max(1, Math.min(4, us.mention_count)) });
    links.push({ source: `session-${us.session_id}`, target: `symptom-${us.symptom_id}`, weight: 1 });
  }

  // 3. Conditions with their symptom links
  const conditions = db.prepare("SELECT id, name, related_symptom_ids FROM conditions LIMIT 20").all() as { id: number; name: string; related_symptom_ids: string }[];
  for (const c of conditions) {
    let relIds: number[] = [];
    try { relIds = JSON.parse(c.related_symptom_ids); } catch { /* empty */ }

    // Only add condition if at least one of its symptoms is already in the graph
    const linkedSymptoms = relIds.filter(sid => nodeSet.has(`symptom-${sid}`));
    if (linkedSymptoms.length === 0) continue;

    addNode({ id: `condition-${c.id}`, name: c.name, type: "condition", val: 3 });
    for (const sid of linkedSymptoms) {
      links.push({ source: `condition-${c.id}`, target: `symptom-${sid}`, weight: 1 });
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

  return { nodes: [...nodeMap.values()], links };
}

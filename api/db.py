"""SQLite helpers for CareFlow FastAPI backend."""
import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from api.config import DATABASE_PATH


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DATABASE_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    """Create tables if they don't exist (called on startup)."""
    conn = get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            user_id INTEGER,
            status TEXT NOT NULL DEFAULT 'pending',
            instruction TEXT,
            intake_summary TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS agent_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            agent_name TEXT,
            event_type TEXT,
            payload TEXT NOT NULL DEFAULT '{}',
            timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS symptoms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            category TEXT,
            mention_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_agent_events_run ON agent_events(run_id);
        CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

        CREATE TABLE IF NOT EXISTS budget_sessions (
            run_id TEXT PRIMARY KEY,
            total_budget_usd REAL NOT NULL,
            per_agent_usd REAL NOT NULL,
            num_agents INTEGER NOT NULL DEFAULT 4,
            agents_done INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'allocating',
            stripe_session_id TEXT,
            checkout_url TEXT,
            requester_address TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS agent_wallets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            allocated_usd REAL NOT NULL DEFAULT 0,
            spent_usd REAL NOT NULL DEFAULT 0,
            balance_usd REAL NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            funded_at TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(run_id, agent_name)
        );

        CREATE TABLE IF NOT EXISTS shopping_cart (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            platform TEXT NOT NULL,
            item_name TEXT,
            item_price REAL NOT NULL DEFAULT 0,
            item_url TEXT,
            item_description TEXT,
            in_stock INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_wallets_run ON agent_wallets(run_id);
        CREATE INDEX IF NOT EXISTS idx_cart_run ON shopping_cart(run_id);
    """)
    conn.commit()
    conn.close()


def insert_run(run_id: str, instruction: str, intake_summary: Optional[str] = None) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO runs (id, instruction, intake_summary, status) VALUES (?, ?, ?, 'pending')",
        (run_id, instruction, intake_summary),
    )
    conn.commit()
    conn.close()


def get_run(run_id: str) -> Optional[Dict[str, Any]]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def update_run_status(run_id: str, status: str) -> None:
    conn = get_conn()
    conn.execute(
        "UPDATE runs SET status = ?, updated_at = datetime('now') WHERE id = ?",
        (status, run_id),
    )
    conn.commit()
    conn.close()


def get_routing_decision(run_id: str) -> Optional[Dict[str, Any]]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM routing_decisions WHERE run_id = ?", (run_id,)).fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    d["next_actions"] = json.loads(d.get("next_actions") or "[]")
    d["disclaimers"] = json.loads(d.get("disclaimers") or "[]")
    d["payment_required"] = bool(d.get("payment_required"))
    d["requires_doctor_approval"] = bool(d.get("requires_doctor_approval"))
    return d


def upsert_routing_decision(d: Dict[str, Any]) -> None:
    conn = get_conn()
    conn.execute(
        """INSERT OR REPLACE INTO routing_decisions
           (run_id, urgency, recommended_path, summary, next_actions, payment_required,
            payment_amount, requires_doctor_approval, rationale, disclaimers)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            d["run_id"], d.get("urgency", "wellness"), d.get("recommended_path", "self_care"),
            d.get("summary"), json.dumps(d.get("next_actions", [])),
            int(d.get("payment_required", False)), float(d.get("payment_amount_usd", 0)),
            int(d.get("requires_doctor_approval", False)), d.get("rationale"),
            json.dumps(d.get("disclaimers", [])),
        ),
    )
    conn.execute(
        "UPDATE runs SET status = 'routed', updated_at = datetime('now') WHERE id = ?",
        (d["run_id"],),
    )
    conn.commit()
    conn.close()


def insert_agent_event(run_id: str, agent_name: str, event_type: str, payload: Dict[str, Any]) -> None:
    conn = get_conn()
    conn.execute(
        "INSERT INTO agent_events (run_id, agent_name, event_type, payload) VALUES (?, ?, ?, ?)",
        (run_id, agent_name, event_type, json.dumps(payload)),
    )
    conn.commit()
    conn.close()


# ---------------------------------------------------------------------------
# Budget / wallet helpers
# ---------------------------------------------------------------------------

def init_budget_session(run_id: str, total_usd: float, per_agent_usd: float,
                         num_agents: int, requester_address: str) -> None:
    conn = get_conn()
    conn.execute(
        """INSERT OR IGNORE INTO budget_sessions
           (run_id, total_budget_usd, per_agent_usd, num_agents, requester_address)
           VALUES (?, ?, ?, ?, ?)""",
        (run_id, total_usd, per_agent_usd, num_agents, requester_address),
    )
    conn.commit()
    conn.close()


def update_budget_session(run_id: str, **kwargs) -> None:
    allowed = {"status", "agents_done", "stripe_session_id", "checkout_url"}
    sets = ", ".join(f"{k} = ?" for k in kwargs if k in allowed)
    vals = [v for k, v in kwargs.items() if k in allowed]
    if not sets:
        return
    conn = get_conn()
    conn.execute(
        f"UPDATE budget_sessions SET {sets}, updated_at = datetime('now') WHERE run_id = ?",
        (*vals, run_id),
    )
    conn.commit()
    conn.close()


def get_budget_session(run_id: str) -> Optional[Dict[str, Any]]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM budget_sessions WHERE run_id = ?", (run_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def init_wallet(run_id: str, agent_name: str, allocated_usd: float) -> None:
    conn = get_conn()
    conn.execute(
        """INSERT OR IGNORE INTO agent_wallets (run_id, agent_name, allocated_usd, balance_usd)
           VALUES (?, ?, ?, ?)""",
        (run_id, agent_name, allocated_usd, allocated_usd),
    )
    conn.commit()
    conn.close()


def fund_wallet(run_id: str, agent_name: str) -> None:
    conn = get_conn()
    conn.execute(
        """UPDATE agent_wallets SET status = 'funded', funded_at = datetime('now'),
           updated_at = datetime('now') WHERE run_id = ? AND agent_name = ?""",
        (run_id, agent_name),
    )
    conn.commit()
    conn.close()


def debit_wallet(run_id: str, agent_name: str, amount: float) -> None:
    conn = get_conn()
    conn.execute(
        """UPDATE agent_wallets
           SET spent_usd = spent_usd + ?, balance_usd = balance_usd - ?,
               status = 'done', updated_at = datetime('now')
           WHERE run_id = ? AND agent_name = ?""",
        (amount, amount, run_id, agent_name),
    )
    conn.commit()
    conn.close()


def get_wallet(run_id: str, agent_name: str) -> Optional[Dict[str, Any]]:
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM agent_wallets WHERE run_id = ? AND agent_name = ?",
        (run_id, agent_name),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def get_all_wallets(run_id: str) -> List[Dict[str, Any]]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM agent_wallets WHERE run_id = ? ORDER BY agent_name",
        (run_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def insert_cart_item(run_id: str, agent_name: str, platform: str,
                     item_name: Optional[str], price: float,
                     url: Optional[str], description: Optional[str],
                     in_stock: bool) -> None:
    conn = get_conn()
    conn.execute(
        """INSERT INTO shopping_cart
           (run_id, agent_name, platform, item_name, item_price, item_url, item_description, in_stock)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (run_id, agent_name, platform, item_name, price, url, description, int(in_stock)),
    )
    conn.commit()
    conn.close()


def get_cart_items(run_id: str) -> List[Dict[str, Any]]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM shopping_cart WHERE run_id = ? ORDER BY created_at",
        (run_id,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_agent_events(run_id: str, since: int = 0) -> List[Dict[str, Any]]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM agent_events WHERE run_id = ? ORDER BY id ASC",
        (run_id,),
    ).fetchall()
    conn.close()
    result = [dict(r) for r in rows]
    return result[since:]

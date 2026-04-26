"""
Seed prana.db with realistic knowledge graph data for common illnesses.
Run: python scripts/seed_kg.py
"""
import json
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parents[1] / "prana.db"

CONDITIONS = [
    ("Influenza (Flu)", ["Fever", "Body Aches", "Fatigue", "Chills", "Headache", "Dry Cough", "Sore Throat"]),
    ("Common Cold", ["Runny Nose", "Sneezing", "Sore Throat", "Mild Cough", "Congestion", "Low-grade Fever"]),
    ("COVID-19", ["Fever", "Dry Cough", "Fatigue", "Loss of Smell", "Loss of Taste", "Shortness of Breath", "Body Aches", "Headache"]),
    ("Seasonal Allergies", ["Sneezing", "Runny Nose", "Itchy Eyes", "Congestion", "Watery Eyes", "Postnasal Drip"]),
    ("Strep Throat", ["Severe Sore Throat", "Fever", "Swollen Lymph Nodes", "Difficulty Swallowing", "Red Tonsils"]),
    ("Anxiety Disorder", ["Excessive Worry", "Restlessness", "Fatigue", "Difficulty Concentrating", "Muscle Tension", "Insomnia", "Rapid Heartbeat"]),
    ("Migraine", ["Severe Headache", "Nausea", "Vomiting", "Light Sensitivity", "Sound Sensitivity", "Visual Aura"]),
    ("Type 2 Diabetes", ["Frequent Urination", "Excessive Thirst", "Fatigue", "Blurred Vision", "Slow Healing", "Tingling in Hands"]),
    ("Hypertension", ["Headache", "Dizziness", "Chest Pain", "Shortness of Breath", "Nosebleeds", "Fatigue"]),
    ("Gastroenteritis", ["Nausea", "Vomiting", "Diarrhea", "Stomach Cramps", "Low-grade Fever", "Fatigue"]),
    ("Urinary Tract Infection", ["Burning Urination", "Frequent Urination", "Cloudy Urine", "Pelvic Pain", "Low-grade Fever"]),
    ("Depression", ["Persistent Sadness", "Fatigue", "Insomnia", "Loss of Interest", "Difficulty Concentrating", "Appetite Changes"]),
    ("Asthma", ["Shortness of Breath", "Wheezing", "Chest Tightness", "Dry Cough", "Difficulty Breathing at Night"]),
    ("Acid Reflux (GERD)", ["Heartburn", "Regurgitation", "Chest Pain", "Difficulty Swallowing", "Chronic Cough", "Sore Throat"]),
    ("Eczema", ["Dry Skin", "Itching", "Red Rash", "Skin Inflammation", "Blisters", "Skin Cracking"]),
]

SYMPTOM_CATEGORIES = {
    "Fever": "systemic", "Body Aches": "musculoskeletal", "Fatigue": "systemic",
    "Chills": "systemic", "Headache": "neurological", "Dry Cough": "respiratory",
    "Sore Throat": "ENT", "Severe Sore Throat": "ENT", "Runny Nose": "ENT",
    "Sneezing": "ENT", "Mild Cough": "respiratory", "Congestion": "ENT",
    "Low-grade Fever": "systemic", "Loss of Smell": "neurological", "Loss of Taste": "neurological",
    "Shortness of Breath": "respiratory", "Itchy Eyes": "ophthalmological", "Watery Eyes": "ophthalmological",
    "Postnasal Drip": "ENT", "Swollen Lymph Nodes": "immunological", "Difficulty Swallowing": "ENT",
    "Red Tonsils": "ENT", "Excessive Worry": "psychiatric", "Restlessness": "psychiatric",
    "Difficulty Concentrating": "neurological", "Muscle Tension": "musculoskeletal",
    "Insomnia": "neurological", "Rapid Heartbeat": "cardiovascular", "Severe Headache": "neurological",
    "Nausea": "gastrointestinal", "Vomiting": "gastrointestinal", "Light Sensitivity": "neurological",
    "Sound Sensitivity": "neurological", "Visual Aura": "neurological", "Frequent Urination": "urological",
    "Excessive Thirst": "endocrine", "Blurred Vision": "ophthalmological", "Slow Healing": "systemic",
    "Tingling in Hands": "neurological", "Dizziness": "neurological", "Chest Pain": "cardiovascular",
    "Nosebleeds": "ENT", "Diarrhea": "gastrointestinal", "Stomach Cramps": "gastrointestinal",
    "Burning Urination": "urological", "Cloudy Urine": "urological", "Pelvic Pain": "urological",
    "Persistent Sadness": "psychiatric", "Loss of Interest": "psychiatric", "Appetite Changes": "psychiatric",
    "Wheezing": "respiratory", "Chest Tightness": "cardiovascular", "Difficulty Breathing at Night": "respiratory",
    "Heartburn": "gastrointestinal", "Regurgitation": "gastrointestinal", "Chronic Cough": "respiratory",
    "Dry Skin": "dermatological", "Itching": "dermatological", "Red Rash": "dermatological",
    "Skin Inflammation": "dermatological", "Blisters": "dermatological", "Skin Cracking": "dermatological",
}

SESSIONS = [
    ("room-flu-001", "2026-04-20 09:15:00", "2026-04-20 09:32:00"),
    ("room-cold-002", "2026-04-21 14:20:00", "2026-04-21 14:38:00"),
    ("room-anxiety-003", "2026-04-22 10:05:00", "2026-04-22 10:25:00"),
    ("room-migraine-004", "2026-04-23 16:45:00", "2026-04-23 17:00:00"),
    ("room-allergy-005", "2026-04-24 08:30:00", "2026-04-24 08:50:00"),
]

RUNS = [
    ("2026-04-20 09:35:00", "I have a high fever, body aches, chills, and a dry cough since yesterday.", "urgent", "pharmacy",
     "Symptoms are consistent with influenza. Rest, hydration, and OTC fever reducers recommended. Consult a doctor if fever exceeds 103°F or symptoms worsen after 48 hours.",
     ["Take ibuprofen or acetaminophen for fever and pain", "Rest and stay hydrated", "Monitor temperature every 4 hours", "Seek medical care if symptoms worsen"]),
    ("2026-04-21 14:40:00", "Runny nose, sneezing, mild sore throat, no fever. Congestion is making it hard to sleep.",
     "routine", "pharmacy",
     "Symptoms suggest a common cold. Decongestants and antihistamines may relieve congestion. Symptoms typically resolve within 7–10 days.",
     ["Try an OTC decongestant before bed", "Use saline nasal spray", "Stay hydrated and rest well", "Avoid contact with others to prevent spread"]),
    ("2026-04-22 10:28:00", "I've been feeling extremely anxious and can't sleep. My heart races and I can't stop worrying.",
     "routine", "mental_health",
     "Symptoms indicate moderate anxiety affecting sleep and daily function. Mindfulness techniques and structured breathing may help short-term. Professional mental health support is recommended.",
     ["Try a 4-7-8 breathing exercise before bed", "Limit caffeine and screen time after 8 PM", "Consider speaking with a therapist or counselor", "Contact a crisis line if anxiety becomes overwhelming"]),
    ("2026-04-23 17:05:00", "Severe throbbing headache behind my left eye, nausea, and extreme light sensitivity. Lasted 4 hours.",
     "urgent", "doctor",
     "Symptoms are consistent with migraine with aura. Medical evaluation is recommended to rule out other causes. OTC triptans may offer relief if previously prescribed.",
     ["Rest in a dark, quiet room", "Apply a cold compress to the forehead", "Schedule an appointment with a neurologist", "Track headache frequency in a diary"]),
    ("2026-04-24 08:52:00", "Sneezing a lot, itchy watery eyes, congestion. Happens every spring. Think it might be allergies.",
     "wellness", "pharmacy",
     "Symptoms are consistent with seasonal allergic rhinitis. Antihistamines and nasal corticosteroid sprays are first-line treatments. Avoiding allergen triggers is also beneficial.",
     ["Try a non-drowsy antihistamine like loratadine", "Use a HEPA air purifier indoors", "Check daily pollen counts before going outside", "Consider allergy testing for long-term management"]),
]

SESSION_SYMPTOMS = {
    0: ["Fever", "Body Aches", "Fatigue", "Chills", "Dry Cough"],
    1: ["Runny Nose", "Sneezing", "Sore Throat", "Congestion"],
    2: ["Excessive Worry", "Insomnia", "Fatigue", "Rapid Heartbeat"],
    3: ["Severe Headache", "Nausea", "Light Sensitivity", "Visual Aura"],
    4: ["Sneezing", "Runny Nose", "Itchy Eyes", "Watery Eyes", "Congestion"],
}


def seed():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")

    # Insert users
    conn.execute("INSERT OR IGNORE INTO users (id, email, name) VALUES (1, 'demo@prana.ai', 'Demo User')")

    # Insert sessions
    session_ids = []
    for voice_room, started_at, ended_at in SESSIONS:
        cur = conn.execute(
            "INSERT INTO sessions (user_id, voice_room, started_at, ended_at) VALUES (1, ?, ?, ?)",
            (voice_room, started_at, ended_at)
        )
        session_ids.append(cur.lastrowid)
    print(f"Inserted {len(session_ids)} sessions")

    # Insert symptoms
    symptom_id_map = {}
    all_symptoms = set(s for _, symptoms in CONDITIONS for s in symptoms)
    for sym_name in sorted(all_symptoms):
        category = SYMPTOM_CATEGORIES.get(sym_name, "general")
        mention_count = sum(
            1 for _, symptoms in CONDITIONS if sym_name in symptoms
        )
        existing = conn.execute("SELECT id FROM symptoms WHERE name = ?", (sym_name,)).fetchone()
        if existing:
            symptom_id_map[sym_name] = existing[0]
            conn.execute("UPDATE symptoms SET mention_count = ? WHERE id = ?", (mention_count, existing[0]))
        else:
            cur = conn.execute(
                "INSERT INTO symptoms (name, category, mention_count) VALUES (?, ?, ?)",
                (sym_name, category, mention_count)
            )
            symptom_id_map[sym_name] = cur.lastrowid
    print(f"Inserted/updated {len(symptom_id_map)} symptoms")

    # Insert conditions with related symptom IDs
    condition_id_map = {}
    for cond_name, symptoms in CONDITIONS:
        sym_ids = [symptom_id_map[s] for s in symptoms if s in symptom_id_map]
        existing = conn.execute("SELECT id FROM conditions WHERE name = ?", (cond_name,)).fetchone()
        if existing:
            condition_id_map[cond_name] = existing[0]
            conn.execute("UPDATE conditions SET related_symptom_ids = ? WHERE id = ?",
                         (json.dumps(sym_ids), existing[0]))
        else:
            cur = conn.execute(
                "INSERT INTO conditions (name, related_symptom_ids) VALUES (?, ?)",
                (cond_name, json.dumps(sym_ids))
            )
            condition_id_map[cond_name] = cur.lastrowid
    print(f"Inserted/updated {len(condition_id_map)} conditions")

    # Link sessions → symptoms via user_symptoms
    for idx, session_db_id in enumerate(session_ids):
        for sym_name in SESSION_SYMPTOMS.get(idx, []):
            sym_id = symptom_id_map.get(sym_name)
            if not sym_id:
                continue
            existing = conn.execute(
                "SELECT 1 FROM user_symptoms WHERE user_id = 1 AND symptom_id = ?", (sym_id,)
            ).fetchone()
            if existing:
                conn.execute(
                    "UPDATE user_symptoms SET mention_count = mention_count + 1, session_id = ? WHERE user_id = 1 AND symptom_id = ?",
                    (session_db_id, sym_id)
                )
            else:
                conn.execute(
                    "INSERT INTO user_symptoms (user_id, symptom_id, session_id, mention_count) VALUES (1, ?, ?, 1)",
                    (sym_id, session_db_id)
                )
    print(f"Linked session→symptom edges")

    # Insert runs and routing decisions
    import uuid
    for created_at, instruction, urgency, path, summary, next_actions in RUNS:
        run_id = str(uuid.uuid4())
        conn.execute(
            "INSERT OR IGNORE INTO runs (id, user_id, status, instruction, intake_summary, created_at, updated_at) VALUES (?, 1, 'routed', ?, ?, ?, ?)",
            (run_id, instruction, summary, created_at, created_at),
        )
        conn.execute(
            """INSERT OR IGNORE INTO routing_decisions
               (run_id, urgency, recommended_path, summary, next_actions, payment_required,
                payment_amount, requires_doctor_approval, rationale, disclaimers)
               VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)""",
            (run_id, urgency, path, summary, json.dumps(next_actions),
             f"Routed based on reported symptoms and urgency assessment.",
             json.dumps(["Prana is a wellness education tool, not a substitute for licensed medical care."])),
        )
    print(f"Inserted {len(RUNS)} runs with routing decisions")

    conn.commit()
    conn.close()
    print("Done. Knowledge graph seeded.")


if __name__ == "__main__":
    seed()

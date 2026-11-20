import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

from models import DictionaryEntry, normalize_katakana

DEFAULT_DB_PATH = os.getenv("AIDICT_DB_PATH", "aidict.db")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def get_connection(db_path: str = DEFAULT_DB_PATH) -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(db_path, timeout=15.0)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _row_to_entry(row: sqlite3.Row) -> dict[str, Any]:
    payload = json.loads(row["data_json"])
    return {
        "id": row["id"],
        "katakana": row["katakana"],
        "model_name": row["model_name"],
        "ollama_host": row["ollama_host"],
        "written_forms": payload.get("written_forms", []),
        "notes": payload.get("notes", []),
        "upvotes": row["upvotes"],
        "downvotes": row["downvotes"],
        "score": row["upvotes"] - row["downvotes"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def init_db(db_path: str = DEFAULT_DB_PATH, legacy_json_path: str = "data.json") -> int:
    """Create tables if needed and migrate legacy data.json once if the database is empty."""
    with get_connection(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                katakana TEXT NOT NULL,
                model_name TEXT NOT NULL DEFAULT 'unknown',
                ollama_host TEXT NOT NULL DEFAULT '',
                data_json TEXT NOT NULL,
                upvotes INTEGER NOT NULL DEFAULT 0,
                downvotes INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_entries_katakana ON entries(katakana)"
        )

        count = conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        if count == 0 and legacy_json_path and os.path.exists(legacy_json_path):
            return _migrate_legacy_json(conn, legacy_json_path)
    return 0


def _migrate_legacy_json(conn: sqlite3.Connection, legacy_json_path: str) -> int:
    try:
        with open(legacy_json_path, "r", encoding="utf-8") as f:
            raw_items = json.load(f)
    except Exception:
        return 0

    if not isinstance(raw_items, list):
        return 0

    now = _utc_now_iso()
    imported = 0
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        try:
            entry = DictionaryEntry.model_validate(item)
        except Exception:
            continue
        katakana = normalize_katakana(entry.katakana)
        if not katakana:
            continue
        payload = {
            "written_forms": [wf.model_dump() for wf in entry.written_forms],
            "notes": entry.notes,
        }
        conn.execute(
            """
            INSERT INTO entries (
                katakana, model_name, ollama_host, data_json,
                upvotes, downvotes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 0, 0, ?, ?)
            """,
            (
                katakana,
                "imported (data.json)",
                "",
                json.dumps(payload, ensure_ascii=False),
                now,
                now,
            ),
        )
        imported += 1
    return imported


def list_words(query: str = "", db_path: str = DEFAULT_DB_PATH) -> list[dict[str, Any]]:
    """Return grouped words with entry counts and preview written forms."""
    raw_query = query.strip()
    norm_query = normalize_katakana(raw_query)

    with get_connection(db_path) as conn:
        rows = conn.execute(
            """
            SELECT id, katakana, model_name, ollama_host, data_json,
                   upvotes, downvotes, created_at, updated_at
            FROM entries
            ORDER BY (upvotes - downvotes) DESC, created_at DESC, id DESC
            """
        ).fetchall()

    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        katakana = row["katakana"]
        data_json = row["data_json"]

        if raw_query:
            matched = (
                raw_query.lower() in katakana.lower()
                or norm_query.lower() in katakana.lower()
                or raw_query.lower() in data_json.lower()
            )
            if not matched:
                continue

        payload = json.loads(data_json)
        forms = [
            wf.get("form", "")
            for wf in payload.get("written_forms", [])
            if wf.get("form")
        ]
        score = row["upvotes"] - row["downvotes"]

        if katakana not in grouped:
            grouped[katakana] = {
                "katakana": katakana,
                "entry_count": 0,
                "best_score": score,
                "latest_at": row["created_at"],
                "preview_forms": [],
            }

        item = grouped[katakana]
        item["entry_count"] += 1
        if score > item["best_score"]:
            item["best_score"] = score
        if row["created_at"] > item["latest_at"]:
            item["latest_at"] = row["created_at"]
        for form in forms:
            if form not in item["preview_forms"] and len(item["preview_forms"]) < 4:
                item["preview_forms"].append(form)

    result = list(grouped.values())
    result.sort(key=lambda x: (x["latest_at"], x["katakana"]), reverse=True)
    return result


def get_entries_by_katakana(
    katakana: str, db_path: str = DEFAULT_DB_PATH
) -> list[dict[str, Any]]:
    norm = normalize_katakana(katakana)
    with get_connection(db_path) as conn:
        rows = conn.execute(
            """
            SELECT id, katakana, model_name, ollama_host, data_json,
                   upvotes, downvotes, created_at, updated_at
            FROM entries
            WHERE katakana = ?
            ORDER BY (upvotes - downvotes) DESC, created_at DESC, id DESC
            """,
            (norm,),
        ).fetchall()
    return [_row_to_entry(r) for r in rows]


def get_entry_by_id(
    entry_id: int, db_path: str = DEFAULT_DB_PATH
) -> dict[str, Any] | None:
    with get_connection(db_path) as conn:
        row = conn.execute(
            """
            SELECT id, katakana, model_name, ollama_host, data_json,
                   upvotes, downvotes, created_at, updated_at
            FROM entries
            WHERE id = ?
            """,
            (entry_id,),
        ).fetchone()
    return _row_to_entry(row) if row else None


def add_entry(
    entry: DictionaryEntry,
    model_name: str,
    ollama_host: str,
    db_path: str = DEFAULT_DB_PATH,
) -> dict[str, Any]:
    katakana = normalize_katakana(entry.katakana)
    now = _utc_now_iso()
    payload = {
        "written_forms": [wf.model_dump() for wf in entry.written_forms],
        "notes": entry.notes,
    }
    with get_connection(db_path) as conn:
        cursor = conn.execute(
            """
            INSERT INTO entries (
                katakana, model_name, ollama_host, data_json,
                upvotes, downvotes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 0, 0, ?, ?)
            """,
            (
                katakana,
                model_name,
                ollama_host,
                json.dumps(payload, ensure_ascii=False),
                now,
                now,
            ),
        )
        new_id = cursor.lastrowid
        row = conn.execute(
            """
            SELECT id, katakana, model_name, ollama_host, data_json,
                   upvotes, downvotes, created_at, updated_at
            FROM entries WHERE id = ?
            """,
            (new_id,),
        ).fetchone()
    return _row_to_entry(row)


def update_entry(
    entry_id: int,
    entry: DictionaryEntry,
    db_path: str = DEFAULT_DB_PATH,
) -> dict[str, Any] | None:
    katakana = normalize_katakana(entry.katakana)
    now = _utc_now_iso()
    payload = {
        "written_forms": [wf.model_dump() for wf in entry.written_forms],
        "notes": entry.notes,
    }
    with get_connection(db_path) as conn:
        cursor = conn.execute(
            """
            UPDATE entries
            SET katakana = ?, data_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                katakana,
                json.dumps(payload, ensure_ascii=False),
                now,
                entry_id,
            ),
        )
        if cursor.rowcount == 0:
            return None
        row = conn.execute(
            """
            SELECT id, katakana, model_name, ollama_host, data_json,
                   upvotes, downvotes, created_at, updated_at
            FROM entries WHERE id = ?
            """,
            (entry_id,),
        ).fetchone()
    return _row_to_entry(row)


def delete_entry(entry_id: int, db_path: str = DEFAULT_DB_PATH) -> bool:
    with get_connection(db_path) as conn:
        cursor = conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
        return cursor.rowcount > 0


def vote_entry(
    entry_id: int,
    direction: str,
    db_path: str = DEFAULT_DB_PATH,
) -> dict[str, Any] | None:
    if direction == "up":
        col = "upvotes"
    elif direction == "down":
        col = "downvotes"
    else:
        raise ValueError("direction must be 'up' or 'down'")

    with get_connection(db_path) as conn:
        cursor = conn.execute(
            f"UPDATE entries SET {col} = {col} + 1 WHERE id = ?",
            (entry_id,),
        )
        if cursor.rowcount == 0:
            return None
        row = conn.execute(
            """
            SELECT id, katakana, model_name, ollama_host, data_json,
                   upvotes, downvotes, created_at, updated_at
            FROM entries WHERE id = ?
            """,
            (entry_id,),
        ).fetchone()
    return _row_to_entry(row)

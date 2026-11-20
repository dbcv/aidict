import os
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, url_for
from pydantic import ValidationError

load_dotenv()

import db
import llm
from models import DictionaryEntry, normalize_katakana

app = Flask(__name__)

# Initialize SQLite database and import legacy data.json on first run
imported_count = db.init_db()
if imported_count:
    print(f"Migrated {imported_count} entries from data.json into SQLite.")


@app.route("/", methods=["GET"])
def index():
    return render_template(
        "index.html",
        default_ollama_host=llm.DEFAULT_OLLAMA_HOST,
        default_model=llm.DEFAULT_OLLAMA_MODEL,
    )


@app.route("/playground", methods=["GET"])
def playground():
    return redirect(url_for("index"))


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


@app.route("/api/models", methods=["GET"])
def api_models():
    host = request.args.get("host", llm.DEFAULT_OLLAMA_HOST)
    try:
        validated_host = llm.validate_ollama_host(host)
        models = llm.list_models(validated_host)
        return jsonify({"host": validated_host, "models": models})
    except ValueError as e:
        return jsonify({"error": str(e), "models": []}), 400
    except Exception as e:
        return (
            jsonify(
                {
                    "error": f"Ollama に接続できませんでした: {e}",
                    "models": [],
                }
            ),
            502,
        )


@app.route("/api/words", methods=["GET"])
def api_words():
    query = request.args.get("q", "")
    words = db.list_words(query=query)
    return jsonify({"words": words})


@app.route("/api/entries", methods=["GET"])
def api_entries():
    word = request.args.get("word", "")
    katakana = normalize_katakana(word)
    if not katakana:
        return jsonify({"katakana": "", "entries": []})
    entries = db.get_entries_by_katakana(katakana)
    return jsonify({"katakana": katakana, "entries": entries})


@app.route("/api/generate", methods=["POST"])
def api_generate():
    body = request.get_json(silent=True) or {}
    raw_word = body.get("word") or body.get("prompt") or ""
    katakana = normalize_katakana(raw_word)
    if not katakana:
        return jsonify({"error": "語句を入力してください。"}), 400

    force = bool(body.get("force", False))
    model_name = (body.get("model") or llm.DEFAULT_OLLAMA_MODEL).strip()
    ollama_host = body.get("ollama_host") or llm.DEFAULT_OLLAMA_HOST

    if not force:
        cached_entries = db.get_entries_by_katakana(katakana)
        if cached_entries:
            return jsonify(
                {
                    "cached": True,
                    "katakana": katakana,
                    "entries": cached_entries,
                }
            )

    try:
        validated_host = llm.validate_ollama_host(ollama_host)
        entry = llm.generate_dictionary_entry(
            word=katakana,
            model=model_name,
            ollama_host=validated_host,
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except ValidationError as e:
        return jsonify({"error": f"LLM出力のJSON検証に失敗しました: {e}"}), 502
    except Exception as e:
        return jsonify({"error": f"LLM生成中にエラーが発生しました: {e}"}), 502

    created = db.add_entry(
        entry=entry,
        model_name=model_name,
        ollama_host=validated_host,
    )
    entries = db.get_entries_by_katakana(katakana)
    return jsonify(
        {
            "cached": False,
            "katakana": katakana,
            "created_entry_id": created["id"],
            "entries": entries,
        }
    )


@app.route("/api/entries/<int:entry_id>", methods=["PUT"])
def api_update_entry(entry_id: int):
    body = request.get_json(silent=True) or {}
    try:
        entry = DictionaryEntry.model_validate(body)
    except ValidationError as e:
        return jsonify({"error": f"入力データが不正です: {e}"}), 400

    if not normalize_katakana(entry.katakana):
        return jsonify({"error": "カタカナ読みは必須です。"}), 400

    updated = db.update_entry(entry_id, entry)
    if not updated:
        return jsonify({"error": "エントリが見つかりません。"}), 404

    entries = db.get_entries_by_katakana(updated["katakana"])
    return jsonify({"entry": updated, "entries": entries})


@app.route("/api/entries/<int:entry_id>", methods=["DELETE"])
def api_delete_entry(entry_id: int):
    existing = db.get_entry_by_id(entry_id)
    if not existing:
        return jsonify({"error": "エントリが見つかりません。"}), 404

    katakana = existing["katakana"]
    db.delete_entry(entry_id)
    entries = db.get_entries_by_katakana(katakana)
    return jsonify({"deleted_id": entry_id, "katakana": katakana, "entries": entries})


@app.route("/api/entries/<int:entry_id>/vote", methods=["POST"])
def api_vote_entry(entry_id: int):
    body = request.get_json(silent=True) or {}
    direction = body.get("direction")
    if direction not in ("up", "down"):
        return jsonify({"error": "direction は 'up' または 'down' を指定してください。"}), 400

    updated = db.vote_entry(entry_id, direction)
    if not updated:
        return jsonify({"error": "エントリが見つかりません。"}), 404

    entries = db.get_entries_by_katakana(updated["katakana"])
    return jsonify({"entry": updated, "entries": entries})


# Legacy compatibility endpoint
@app.route("/generate", methods=["POST"])
def legacy_generate():
    body = request.get_json(silent=True) or {}
    prompt = body.get("prompt", "")
    katakana = normalize_katakana(prompt)
    if not katakana:
        return jsonify({"error": "prompt is required"}), 400

    model_name = (body.get("model") or llm.DEFAULT_OLLAMA_MODEL).strip()
    ollama_host = body.get("ollama_host") or llm.DEFAULT_OLLAMA_HOST
    try:
        validated_host = llm.validate_ollama_host(ollama_host)
        entry = llm.generate_dictionary_entry(katakana, model_name, validated_host)
        db.add_entry(entry, model_name, validated_host)
        return jsonify({"generated_text": entry.model_dump_json()})
    except Exception as e:
        return jsonify({"error": str(e)}), 502


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)

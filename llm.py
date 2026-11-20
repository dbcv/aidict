import os
from urllib.parse import urlparse

from ollama import Client

from models import DictionaryEntry, normalize_katakana

DEFAULT_OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
DEFAULT_OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "nemotron3:33b")

SYSTEM_PROMPT = """あなたは正確で丁寧な日本語辞書の編纂者です。
ユーザーから与えられた「カタカナ読み」のみを手がかりに、日本語の辞書エントリを構造化JSONで作成してください。

以下のルールを厳守してください：
1. 現代日本語で一般的・使用頻度の高い表記や同音異義語を優先して挙げてください。実在しない造語や不自然な中国語由来の当て字は避けてください。
2. 一般語だけでなく、よく知られた固有名詞・外来語・略語・地名・流行語・ネットスラング等に該当する場合も適切に含め、category 欄（例: 一般語、固有名詞、外来語、略語、専門用語、俗語）を明記してください。
3. それぞれの表記（written_forms）について、意味が複数ある場合は senses に分けて説明してください。
4. 各意味（sense）には、品詞・用法（part_of_speech）、簡潔で分かりやすい意味説明（meaning）、そしてその意味を自然に表す具体的な例文（examples）を必ず1つ以上含めてください。
5. katakana フィールドには、与えられたカタカナ読みをそのまま設定してください。
6. notes には、同音異義語の使い分け、語源、由来、関連表現など読者の理解に役立つ補足があれば簡潔に記載してください。
"""


def validate_ollama_host(host: str | None) -> str:
    candidate = (host or DEFAULT_OLLAMA_HOST).strip().rstrip("/")
    parsed = urlparse(candidate)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("Ollama エンドポイントは http:// または https:// で始まる有効なURLを指定してください。")
    return candidate


def list_models(ollama_host: str | None = None) -> list[str]:
    host = validate_ollama_host(ollama_host)
    client = Client(host=host, timeout=10.0)
    response = client.list()
    models: list[str] = []
    for item in getattr(response, "models", []) or []:
        name = getattr(item, "model", None) or getattr(item, "name", None)
        if name:
            models.append(name)
    return sorted(set(models))


def generate_dictionary_entry(
    word: str,
    model: str | None = None,
    ollama_host: str | None = None,
) -> DictionaryEntry:
    katakana = normalize_katakana(word)
    if not katakana:
        raise ValueError("検索する語を入力してください。")

    host = validate_ollama_host(ollama_host)
    model_name = (model or DEFAULT_OLLAMA_MODEL).strip()
    if not model_name:
        raise ValueError("モデル名を指定してください。")

    client = Client(host=host)
    response = client.chat(
        model=model_name,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"カタカナ読み「{katakana}」の日本語辞書エントリを作成してください。\n"
                    "複数の漢字表記や表記ゆれ・同音異義語がある場合は主要なものを挙げ、"
                    "それぞれの意味ごとに具体的な例文を1つ以上付けてください。"
                ),
            },
        ],
        format=DictionaryEntry.model_json_schema(),
    )

    content = response.message.content
    entry = DictionaryEntry.model_validate_json(content)
    # Keep the requested normalized katakana as the canonical key
    entry.katakana = katakana
    return entry

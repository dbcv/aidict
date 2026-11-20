import unicodedata
from pydantic import BaseModel, Field


class Example(BaseModel):
    sentence: str = Field(..., description="その意味を表す自然な日本語の用例")


class Sense(BaseModel):
    part_of_speech: str = Field(
        default="",
        description="品詞や用法（例: 名詞、動詞、形容詞、副詞、固有名詞、略語など）",
    )
    meaning: str = Field(..., description="分かりやすく簡潔な意味の説明")
    examples: list[Example] = Field(
        default_factory=list,
        description="この意味を表す具体的な用例一覧（原則1つ以上）",
    )


class WrittenForm(BaseModel):
    form: str = Field(..., description="漢字・カタカナ・英語などの表記")
    category: str = Field(
        default="",
        description="語の分類（例: 一般語、固有名詞、外来語、略語、専門用語、俗語など）",
    )
    senses: list[Sense] = Field(
        default_factory=list,
        description="この表記に対応する意味一覧",
    )


class DictionaryEntry(BaseModel):
    katakana: str = Field(..., description="見出しのカタカナ読み")
    written_forms: list[WrittenForm] = Field(
        default_factory=list,
        description="同音異義語・表記ゆれの一覧",
    )
    notes: list[str] = Field(
        default_factory=list,
        description="語源・使い分け・補足情報など",
    )


def normalize_katakana(text: str) -> str:
    """Normalize input text: strip whitespace, NFKC normalize, and convert hiragana to katakana."""
    if not text:
        return ""
    normalized = unicodedata.normalize("NFKC", text.strip())
    # Collapse internal whitespace
    normalized = " ".join(normalized.split())
    result_chars: list[str] = []
    for ch in normalized:
        code = ord(ch)
        # Hiragana ぁ (0x3041) .. ゖ (0x3096) -> Katakana ァ (0x30A1) .. ヶ (0x30F6)
        if 0x3041 <= code <= 0x3096:
            result_chars.append(chr(code + 0x60))
        else:
            result_chars.append(ch)
    return "".join(result_chars)

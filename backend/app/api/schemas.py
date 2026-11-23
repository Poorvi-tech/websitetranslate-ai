from pydantic import BaseModel, Field, field_validator

from app.core.limits import (
    MAX_INPUT_TOKENS,
    MAX_TEXT_CHARACTERS,
    MAX_TOKEN_COUNT_BATCH_ITEMS,
    MAX_TRANSLATION_BATCH_ITEMS,
)


def _validate_text_segments(values: list[str]) -> list[str]:
    if any(not value.strip() for value in values):
        raise ValueError("Texts must not be empty or whitespace-only.")
    if sum(len(value) for value in values) > MAX_TEXT_CHARACTERS:
        raise ValueError(
            f"Combined text must not exceed {MAX_TEXT_CHARACTERS} characters."
        )
    return values


class TranslationRequest(BaseModel):
    text: str = Field(
        max_length=MAX_TEXT_CHARACTERS,
        description="Text to translate; empty input is not allowed.",
    )
    source_language: str = Field(description="Source language code; currently en.")
    target_language: str = Field(description="Target language code; currently hi.")

    @field_validator("text")
    @classmethod
    def require_non_whitespace_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Text must not be empty or whitespace-only.")
        return value


class TranslationResponse(BaseModel):
    original_text: str
    translated_text: str
    source_language: str
    target_language: str


class TranslationBatchRequest(BaseModel):
    texts: list[str] = Field(
        min_length=1,
        max_length=MAX_TRANSLATION_BATCH_ITEMS,
        description="Text segments; combined text is limited to 2,000 characters.",
    )
    source_language: str = Field(description="Source language code; currently en.")
    target_language: str = Field(description="Target language code; currently hi.")

    @field_validator("texts")
    @classmethod
    def require_non_whitespace_texts(cls, values: list[str]) -> list[str]:
        return _validate_text_segments(values)


class TranslationBatchResponse(BaseModel):
    translated_texts: list[str]


class TokenCountRequest(BaseModel):
    texts: list[str] = Field(
        min_length=1,
        max_length=MAX_TOKEN_COUNT_BATCH_ITEMS,
        description="Text segments to count; combined text is limited to 2,000 characters.",
    )

    @field_validator("texts")
    @classmethod
    def require_non_whitespace_texts(cls, values: list[str]) -> list[str]:
        return _validate_text_segments(values)


class TokenCountResponse(BaseModel):
    token_counts: list[int]
    max_input_tokens: int = MAX_INPUT_TOKENS
    max_text_characters: int = MAX_TEXT_CHARACTERS
    max_token_count_batch_items: int = MAX_TOKEN_COUNT_BATCH_ITEMS

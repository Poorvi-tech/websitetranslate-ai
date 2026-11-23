import logging

from fastapi import APIRouter, HTTPException

from app.api.schemas import (
    TokenCountRequest,
    TokenCountResponse,
    TranslationBatchRequest,
    TranslationBatchResponse,
    TranslationRequest,
    TranslationResponse,
)
from app.core.limits import MAX_TOKEN_COUNT_BATCH_ITEMS, MAX_TRANSLATION_BATCH_ITEMS
from app.services.translation import (
    TranslationError,
    TranslationInputTooLongError,
    translation_service,
)

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/")
def root() -> dict[str, str]:
    return {"message": "WebsiteTranslate AI API"}


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/languages")
def languages() -> dict[str, list[dict[str, str]]]:
    return {
        "languages": [
            {"code": "en", "name": "English"},
            {"code": "hi", "name": "Hindi"},
        ]
    }


@router.post(
    "/token-count",
    response_model=TokenCountResponse,
    summary="Count model tokens for text segments",
    description=(
        f"Returns exact IndicTrans2 token counts for up to "
        f"{MAX_TOKEN_COUNT_BATCH_ITEMS} segments with a "
        "combined limit of 2,000 characters. Use this to prepare valid "
        "translation requests."
    ),
    responses={
        422: {"description": "Invalid or oversized text segments."},
        503: {"description": "Translation model is unavailable."},
    },
)
def token_count(request: TokenCountRequest) -> TokenCountResponse:
    try:
        counts = translation_service.count_tokens(request.texts)
    except TranslationError as exc:
        logger.exception("Translation tokenizer failed")
        raise HTTPException(
            status_code=503,
            detail="Translation service is unavailable. Please try again later.",
        ) from exc
    except Exception as exc:
        logger.exception("Unexpected error while counting translation tokens")
        raise HTTPException(
            status_code=500,
            detail="An unexpected error occurred while counting tokens.",
        ) from exc

    return TokenCountResponse(token_counts=counts)


@router.post(
    "/translate-batch",
    response_model=TranslationBatchResponse,
    summary="Translate a bounded batch of English text segments to Hindi",
    description=(
        f"Translates up to {MAX_TRANSLATION_BATCH_ITEMS} text segments in one "
        "model call. The combined input is limited to 2,000 characters and "
        "each segment to 256 model tokens."
    ),
    responses={
        422: {
            "description": (
                "Invalid request, unsupported language pair, or an over-limit segment."
            )
        },
        500: {"description": "Unexpected internal error."},
        503: {"description": "Translation model is unavailable."},
    },
)
def translate_batch(
    request: TranslationBatchRequest,
) -> TranslationBatchResponse:
    if (request.source_language, request.target_language) != ("en", "hi"):
        raise HTTPException(
            status_code=422,
            detail="Unsupported language pair. Supported pair: en to hi.",
        )

    try:
        translated_texts = translation_service.translate_many(request.texts)
    except TranslationInputTooLongError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TranslationError as exc:
        logger.exception("Batch translation service failed")
        raise HTTPException(
            status_code=503,
            detail="Translation service is unavailable. Please try again later.",
        ) from exc
    except Exception as exc:
        logger.exception("Unexpected error while translating a batch")
        raise HTTPException(
            status_code=500,
            detail="An unexpected error occurred while translating text.",
        ) from exc

    return TranslationBatchResponse(translated_texts=translated_texts)


@router.post(
    "/translate",
    response_model=TranslationResponse,
    summary="Translate English text to Hindi",
    description=(
        "Translates English text to Hindi. Text is limited to 2,000 characters "
        "and 256 model tokens; over-limit inputs are rejected, not truncated."
    ),
    responses={
        422: {
            "description": (
                "Invalid request, unsupported language pair, or input too long."
            )
        },
        500: {"description": "Unexpected internal error."},
        503: {"description": "Translation model is unavailable."},
    },
)
def translate(request: TranslationRequest) -> TranslationResponse:
    if (request.source_language, request.target_language) != ("en", "hi"):
        raise HTTPException(
            status_code=422,
            detail="Unsupported language pair. Supported pair: en to hi.",
        )

    try:
        translated_text = translation_service.translate(request.text)
    except TranslationInputTooLongError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except TranslationError as exc:
        logger.exception("Translation service failed")
        raise HTTPException(
            status_code=503,
            detail="Translation service is unavailable. Please try again later.",
        ) from exc
    except Exception as exc:
        logger.exception("Unexpected error while translating text")
        raise HTTPException(
            status_code=500,
            detail="An unexpected error occurred while translating text.",
        ) from exc

    return TranslationResponse(
        original_text=request.text,
        translated_text=translated_text,
        source_language=request.source_language,
        target_language=request.target_language,
    )

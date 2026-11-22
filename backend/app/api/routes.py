from fastapi import APIRouter

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

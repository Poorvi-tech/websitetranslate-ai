import os


def get_cors_origins() -> list[str]:
    configured_origins = os.getenv("CORS_ORIGINS", "")
    return [
        origin.strip()
        for origin in configured_origins.split(",")
        if origin.strip()
    ]

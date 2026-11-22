import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import create_app


class ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(create_app())

    def test_root(self) -> None:
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"message": "WebsiteTranslate AI API"})

    def test_health(self) -> None:
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_languages_lists_english_and_hindi(self) -> None:
        response = self.client.get("/languages")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "languages": [
                    {"code": "en", "name": "English"},
                    {"code": "hi", "name": "Hindi"},
                ]
            },
        )

    def test_cors_allows_configured_chrome_extension_origin(self) -> None:
        with patch.dict(
            "os.environ",
            {"CORS_ORIGINS": "chrome-extension://test-extension-id"},
        ):
            client = TestClient(create_app())
            response = client.get(
                "/health",
                headers={"Origin": "chrome-extension://test-extension-id"},
            )

        self.assertEqual(
            response.headers["access-control-allow-origin"],
            "chrome-extension://test-extension-id",
        )

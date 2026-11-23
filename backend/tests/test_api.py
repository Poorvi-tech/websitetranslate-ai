import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from app.main import create_app
from app.services.translation import TranslationError, TranslationInputTooLongError


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

    @patch(
        "app.api.routes.translation_service.translate",
        return_value="नमस्ते, आप कैसे हैं?",
    )
    def test_translate_returns_model_output(self, translate: Mock) -> None:
        payload = {
            "text": "Hello, how are you?",
            "source_language": "en",
            "target_language": "hi",
        }

        response = self.client.post("/translate", json=payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "original_text": "Hello, how are you?",
                "translated_text": "नमस्ते, आप कैसे हैं?",
                "source_language": "en",
                "target_language": "hi",
            },
        )
        translate.assert_called_once_with("Hello, how are you?")

    @patch(
        "app.api.routes.translation_service.count_tokens",
        return_value=[5, 12],
    )
    def test_token_count_returns_counts_and_limits(self, count_tokens: Mock) -> None:
        texts = ["Hello", "How are you?"]

        response = self.client.post("/token-count", json={"texts": texts})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "token_counts": [5, 12],
                "max_input_tokens": 256,
                "max_text_characters": 2000,
                "max_token_count_batch_items": 8,
            },
        )
        count_tokens.assert_called_once_with(texts)

    def test_translate_requires_all_fields(self) -> None:
        response = self.client.post("/translate", json={"text": "Hello"})

        self.assertEqual(response.status_code, 422)
        self.assertIn("source_language", response.text)
        self.assertIn("target_language", response.text)

    @patch("app.api.routes.translation_service.translate")
    def test_translate_rejects_empty_request(self, translate: Mock) -> None:
        response = self.client.post("/translate", json={})

        self.assertEqual(response.status_code, 422)
        self.assertIn("text", response.text)
        self.assertIn("source_language", response.text)
        self.assertIn("target_language", response.text)
        translate.assert_not_called()

    @patch("app.api.routes.translation_service.translate")
    def test_translate_rejects_empty_and_whitespace_text(self, translate: Mock) -> None:
        payload = {
            "source_language": "en",
            "target_language": "hi",
        }
        for text in ("", " \t\n "):
            with self.subTest(text=repr(text)):
                response = self.client.post(
                    "/translate",
                    json={**payload, "text": text},
                )

                self.assertEqual(response.status_code, 422)
                self.assertIn("whitespace-only", response.text)

        translate.assert_not_called()

    @patch("app.api.routes.translation_service.translate")
    def test_translate_rejects_unsupported_language_pair(self, translate: Mock) -> None:
        response = self.client.post(
            "/translate",
            json={
                "text": "Hello",
                "source_language": "hi",
                "target_language": "en",
            },
        )

        self.assertEqual(response.status_code, 422)
        self.assertIn("Unsupported language pair", response.text)
        translate.assert_not_called()

    @patch("app.api.routes.translation_service.translate")
    def test_translate_rejects_text_over_character_limit(self, translate: Mock) -> None:
        response = self.client.post(
            "/translate",
            json={
                "text": "a" * 2001,
                "source_language": "en",
                "target_language": "hi",
            },
        )

        self.assertEqual(response.status_code, 422)
        self.assertIn("at most 2000 characters", response.text)
        translate.assert_not_called()

    @patch("app.api.routes.translation_service.count_tokens")
    def test_token_count_rejects_oversized_batch(self, count_tokens: Mock) -> None:
        response = self.client.post(
            "/token-count",
            json={"texts": ["a" * 1001, "b" * 1000]},
        )

        self.assertEqual(response.status_code, 422)
        self.assertIn("Combined text", response.text)
        count_tokens.assert_not_called()

    @patch(
        "app.api.routes.translation_service.translate",
        side_effect=TranslationInputTooLongError("Text exceeds the model limit of 256 tokens."),
    )
    def test_translate_rejects_text_over_model_token_limit(
        self, translate: Mock
    ) -> None:
        response = self.client.post(
            "/translate",
            json={
                "text": "A valid-sized request that tokenizes beyond the model limit.",
                "source_language": "en",
                "target_language": "hi",
            },
        )

        self.assertEqual(response.status_code, 422)
        self.assertIn("256 tokens", response.text)
        translate.assert_called_once()

    @patch(
        "app.api.routes.translation_service.translate",
        side_effect=TranslationError("Model could not be loaded."),
    )
    def test_translate_returns_service_unavailable_when_model_fails(
        self, translate: Mock
    ) -> None:
        with self.assertLogs("app.api.routes", level="ERROR"):
            response = self.client.post(
                "/translate",
                json={
                    "text": "Hello",
                    "source_language": "en",
                    "target_language": "hi",
                },
            )

        self.assertEqual(response.status_code, 503)
        self.assertIn("Translation service is unavailable", response.text)
        translate.assert_called_once()

    @patch(
        "app.api.routes.translation_service.translate",
        side_effect=RuntimeError("unexpected failure"),
    )
    def test_translate_reports_unexpected_internal_error(
        self, translate: Mock
    ) -> None:
        with self.assertLogs("app.api.routes", level="ERROR"):
            response = self.client.post(
                "/translate",
                json={
                    "text": "Hello",
                    "source_language": "en",
                    "target_language": "hi",
                },
            )

        self.assertEqual(response.status_code, 500)
        self.assertIn("unexpected error occurred", response.text)
        translate.assert_called_once()

    @patch(
        "app.api.routes.translation_service.translate",
        side_effect=["नमस्ते", "नमस्कार"],
    )
    def test_multiple_sequential_translation_requests(self, translate: Mock) -> None:
        payload = {
            "text": "Hello",
            "source_language": "en",
            "target_language": "hi",
        }

        first = self.client.post("/translate", json=payload)
        second = self.client.post("/translate", json=payload)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(first.json()["translated_text"], "नमस्ते")
        self.assertEqual(second.json()["translated_text"], "नमस्कार")
        self.assertEqual(translate.call_count, 2)

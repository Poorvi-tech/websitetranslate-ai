import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import torch

from app.services.translation import (
    TORCH_INTEROP_THREADS,
    TORCH_INTRAOP_THREADS,
    TranslationError,
    TranslationInputTooLongError,
    TranslationService,
)


class TranslationServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = TranslationService()

    def test_configures_torch_cpu_thread_counts(self) -> None:
        self.assertEqual(torch.get_num_interop_threads(), TORCH_INTEROP_THREADS)
        self.assertEqual(torch.get_num_threads(), TORCH_INTRAOP_THREADS)

    def test_rejects_empty_and_whitespace_input_without_loading_model(self) -> None:
        for text in ("", " \t\n "):
            with self.subTest(text=repr(text)):
                with self.assertRaisesRegex(ValueError, "non-empty string"):
                    self.service.translate(text)

        self.assertFalse(self.service.is_loaded)

    def test_rejects_invalid_batch_without_loading_model(self) -> None:
        invalid_batches = (
            [],
            ["Hello", ""],
            ["a" * 1001, "b" * 1000],
            ["Hello"] * 9,
        )
        for texts in invalid_batches:
            with self.subTest(texts=texts[:2]):
                with self.assertRaises(ValueError):
                    self.service.translate_many(texts)

        self.assertFalse(self.service.is_loaded)

    @patch(
        "app.services.translation.AutoTokenizer.from_pretrained",
        side_effect=OSError("model files unavailable"),
    )
    def test_reports_model_loading_failure(self, tokenizer_loader: Mock) -> None:
        with self.assertRaises(TranslationError) as raised:
            self.service.translate("Hello")

        self.assertIsInstance(raised.exception.__cause__, OSError)
        tokenizer_loader.assert_called_once()
        self.assertFalse(self.service.is_loaded)

    @patch("app.services.translation.IndicProcessor")
    @patch("app.services.translation.AutoModelForSeq2SeqLM.from_pretrained")
    @patch("app.services.translation.AutoTokenizer.from_pretrained")
    def test_rejects_tokenized_input_over_limit_without_truncating(
        self,
        tokenizer_loader: Mock,
        model_loader: Mock,
        processor_factory: Mock,
    ) -> None:
        inputs = MagicMock()
        inputs.__getitem__.return_value = SimpleNamespace(shape=(1, 257))
        tokenizer = Mock(return_value=inputs)
        tokenizer_loader.return_value = tokenizer
        model = Mock()
        model_loader.return_value = model
        processor = Mock()
        processor_factory.return_value = processor

        with self.assertRaises(TranslationInputTooLongError):
            self.service.translate("Hello")

        self.assertFalse(tokenizer.call_args.kwargs["truncation"])
        self.assertNotIn("max_length", tokenizer.call_args.kwargs)
        inputs.to.assert_not_called()
        model.generate.assert_not_called()

    @patch("app.services.translation.IndicProcessor")
    @patch("app.services.translation.AutoModelForSeq2SeqLM.from_pretrained")
    @patch("app.services.translation.AutoTokenizer.from_pretrained")
    def test_counts_preprocessed_batch_tokens_once(
        self,
        tokenizer_loader: Mock,
        model_loader: Mock,
        processor_factory: Mock,
    ) -> None:
        attention_mask = MagicMock()
        attention_mask.sum.return_value.tolist.return_value = [4, 7]
        encoded = MagicMock()
        encoded.__getitem__.return_value = attention_mask
        tokenizer = Mock(return_value=encoded)
        tokenizer_loader.return_value = tokenizer
        processor = Mock()
        processor.preprocess_batch.return_value = ["prepared one", "prepared two"]
        processor_factory.return_value = processor
        model_loader.return_value = Mock()

        self.assertEqual(self.service.count_tokens(["Hello", "How are you?"]), [4, 7])

        processor.preprocess_batch.assert_called_once_with(
            ["Hello", "How are you?"],
            src_lang="eng_Latn",
            tgt_lang="hin_Deva",
        )
        self.assertFalse(tokenizer.call_args.kwargs["truncation"])
        tokenizer_loader.assert_called_once()
        model_loader.assert_called_once()

    @patch("app.services.translation.IndicProcessor")
    @patch("app.services.translation.AutoModelForSeq2SeqLM.from_pretrained")
    @patch("app.services.translation.AutoTokenizer.from_pretrained")
    def test_loads_once_and_reuses_model(
        self,
        tokenizer_loader: Mock,
        model_loader: Mock,
        processor_factory: Mock,
    ) -> None:
        inputs = MagicMock()
        inputs.__getitem__.return_value = SimpleNamespace(shape=(1, 3))
        inputs.to.return_value = {"input_ids": "tokens"}
        tokenizer = Mock()
        tokenizer.return_value = inputs
        tokenizer.batch_decode.return_value = ["Namaste"]
        tokenizer_loader.return_value = tokenizer

        model = Mock()
        model.generate.return_value = ["generated"]
        model_loader.return_value = model

        processor = Mock()
        processor.postprocess_batch.return_value = ["नमस्ते"]
        processor_factory.return_value = processor

        self.assertEqual(self.service.translate("Hello"), "नमस्ते")
        self.assertEqual(self.service.translate("Hello again"), "नमस्ते")

        tokenizer_loader.assert_called_once()
        model_loader.assert_called_once()
        processor_factory.assert_called_once_with(inference=True)
        self.assertTrue(self.service.is_loaded)
        self.assertIsNotNone(self.service.load_time_seconds)

    @patch("app.services.translation.IndicProcessor")
    @patch("app.services.translation.AutoModelForSeq2SeqLM.from_pretrained")
    @patch("app.services.translation.AutoTokenizer.from_pretrained")
    def test_translates_a_batch_in_one_model_generation(
        self,
        tokenizer_loader: Mock,
        model_loader: Mock,
        processor_factory: Mock,
    ) -> None:
        inputs = MagicMock()
        inputs.__getitem__.return_value = SimpleNamespace(shape=(2, 4))
        inputs.to.return_value = {"input_ids": "tokens"}
        tokenizer = Mock()
        tokenizer.return_value = inputs
        tokenizer.batch_decode.return_value = ["Namaste", "Kaise hain"]
        tokenizer_loader.return_value = tokenizer

        model = Mock()
        model.generate.return_value = ["generated batch"]
        model_loader.return_value = model

        processor = Mock()
        processor.postprocess_batch.return_value = ["नमस्ते", "कैसे हैं"]
        processor_factory.return_value = processor

        self.assertEqual(
            self.service.translate_many(["Hello", "How are you?"]),
            ["नमस्ते", "कैसे हैं"],
        )

        model.generate.assert_called_once()
        tokenizer.batch_decode.assert_called_once()
        processor.postprocess_batch.assert_called_once_with(
            ["Namaste", "Kaise hain"],
            lang="hin_Deva",
        )


if __name__ == "__main__":
    unittest.main()

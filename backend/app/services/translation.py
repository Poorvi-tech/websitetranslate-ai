from threading import Lock
from time import perf_counter

import torch
from IndicTransToolkit.processor import IndicProcessor
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
from transformers.modeling_utils import PreTrainedModel
from transformers.tokenization_utils_base import BatchEncoding, PreTrainedTokenizerBase

from app.core.limits import MAX_INPUT_TOKENS, MAX_TEXT_CHARACTERS

MODEL_ID = "ai4bharat/indictrans2-en-indic-dist-200M"
MODEL_REVISION = "2cfd0a20057756d756bf3e53528f492afc52f91a"
SOURCE_LANGUAGE = "eng_Latn"
TARGET_LANGUAGE = "hin_Deva"


class TranslationError(RuntimeError):
    pass


class TranslationInputTooLongError(ValueError):
    pass


class TranslationService:
    def __init__(self) -> None:
        self._lock = Lock()
        self._tokenizer: PreTrainedTokenizerBase | None = None
        self._model: PreTrainedModel | None = None
        self._processor: IndicProcessor | None = None
        self._load_time_seconds: float | None = None

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    @property
    def load_time_seconds(self) -> float | None:
        return self._load_time_seconds

    def _load_model(self) -> None:
        started_at = perf_counter()
        try:
            tokenizer = AutoTokenizer.from_pretrained(
                MODEL_ID,
                revision=MODEL_REVISION,
                trust_remote_code=True,
            )
            model = AutoModelForSeq2SeqLM.from_pretrained(
                MODEL_ID,
                revision=MODEL_REVISION,
                trust_remote_code=True,
                use_safetensors=True,
            )
            model.to("cpu")
            model.eval()
            processor = IndicProcessor(inference=True)
        except Exception as exc:
            raise TranslationError(
                f"Failed to load the IndicTrans2 model {MODEL_ID}."
            ) from exc

        self._tokenizer = tokenizer
        self._model = model
        self._processor = processor
        self._load_time_seconds = perf_counter() - started_at

    def _encode(self, texts: list[str]) -> BatchEncoding:
        if (
            self._tokenizer is None
            or self._model is None
            or self._processor is None
        ):
            raise TranslationError("IndicTrans2 model initialization is incomplete.")

        processed_texts = self._processor.preprocess_batch(
            texts,
            src_lang=SOURCE_LANGUAGE,
            tgt_lang=TARGET_LANGUAGE,
        )
        return self._tokenizer(
            processed_texts,
            truncation=False,
            padding="longest",
            return_tensors="pt",
            return_attention_mask=True,
        )

    def count_tokens(self, texts: list[str]) -> list[int]:
        if not texts or any(
            not isinstance(text, str) or not text.strip() for text in texts
        ):
            raise ValueError("Texts must be a non-empty list of non-empty strings.")
        if sum(len(text) for text in texts) > MAX_TEXT_CHARACTERS:
            raise ValueError(
                f"Combined text exceeds {MAX_TEXT_CHARACTERS} characters."
            )

        with self._lock:
            if not self.is_loaded:
                self._load_model()

            try:
                encoded = self._encode([text.strip() for text in texts])
                return [
                    int(count)
                    for count in encoded["attention_mask"].sum(dim=1).tolist()
                ]
            except Exception as exc:
                raise TranslationError(
                    "IndicTrans2 token counting failed."
                ) from exc

    def translate(self, text: str) -> str:
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Text must be a non-empty string.")

        with self._lock:
            if not self.is_loaded:
                self._load_model()
            if self._tokenizer is None or self._model is None:
                raise TranslationError("IndicTrans2 model initialization is incomplete.")

            tokenizer = self._tokenizer
            model = self._model
            processor = self._processor

            try:
                inputs = self._encode([text.strip()])
                if inputs["input_ids"].shape[-1] > MAX_INPUT_TOKENS:
                    raise TranslationInputTooLongError(
                        f"Text exceeds the model limit of {MAX_INPUT_TOKENS} tokens."
                    )
                inputs = inputs.to("cpu")

                with torch.inference_mode():
                    generated_tokens = model.generate(
                        **inputs,
                        use_cache=True,
                        min_length=0,
                        max_length=256,
                        num_beams=5,
                        num_return_sequences=1,
                    )

                decoded = tokenizer.batch_decode(
                    generated_tokens,
                    skip_special_tokens=True,
                    clean_up_tokenization_spaces=True,
                )
                translations = processor.postprocess_batch(
                    decoded,
                    lang=TARGET_LANGUAGE,
                )
            except TranslationInputTooLongError:
                raise
            except Exception as exc:
                raise TranslationError("IndicTrans2 translation failed.") from exc

            if len(translations) != 1 or not translations[0].strip():
                raise TranslationError("IndicTrans2 returned an empty translation.")
            return translations[0].strip()


translation_service = TranslationService()

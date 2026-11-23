# IndicTrans2 English-to-Hindi translation

## Model and license

This backend uses [AI4Bharat IndicTrans2 English-to-Indic Distilled 200M](https://huggingface.co/ai4bharat/indictrans2-en-indic-dist-200M), pinned to revision `2cfd0a20057756d756bf3e53528f492afc52f91a`. It is a custom IndicTrans encoder-decoder model with about 275 million float32 parameters. Its Hugging Face model card and the [IndicTrans2 project license](https://github.com/AI4Bharat/IndicTrans2/blob/main/LICENSE) specify the MIT License.

The model repository is gated on Hugging Face: a user must be authenticated and accept its access conditions. Model weights stay in the user's Hugging Face cache, outside this repository. The loader uses the model's custom code with `trust_remote_code=True`; the revision is pinned so the code and weights come from a fixed repository commit.

## Language codes and inference workflow

- English source: `eng_Latn`
- Hindi target: `hin_Deva`

Inference follows the model card and the official [IndicTrans2 Hugging Face workflow](https://github.com/AI4Bharat/IndicTrans2/tree/main/huggingface_interface): `AutoTokenizer` and `AutoModelForSeq2SeqLM` load the custom model, and `IndicTransToolkit.processor.IndicProcessor` performs language-specific preprocessing and postprocessing. It is not loaded through a generic translation pipeline. Generation uses CPU, beam width 5, and a maximum length of 256 tokens.

## Dependencies and installation

The tested environment is WSL Ubuntu 24.04 with Python 3.12.3. The backend pins:

- `torch==2.5.1+cpu` (CPU wheel; no CUDA packages)
- `transformers==4.51.3`
- `indictranstoolkit==1.1.1`
- `sentencepiece==0.2.0` (required by the model's custom tokenizer)
- `numpy==2.1.3`
- `huggingface-hub==0.36.2`

The toolkit requires Python 3.10+ and recommends NumPy 2.1+, PyTorch 2.5+, and Transformers 4.51+. After authenticating to Hugging Face and accepting the model's access conditions, install using the existing backend environment:

```bash
cd backend
source .venv/bin/activate
python -m pip install \
  --index-url https://download.pytorch.org/whl/cpu \
  --extra-index-url https://pypi.org/simple \
  -r requirements.txt
python -m pip check
```

The CPU PyTorch index is used to avoid installing GPU/CUDA packages. Keep Hugging Face credentials in the user's Hugging Face cache; do not put tokens in project files or environment examples.

## Loading and example

`app.services.translation.translation_service` is a reusable lazy-loading instance. It downloads required model files into the Hugging Face cache on first use, then keeps the tokenizer, model, and processor in memory for subsequent translations. The service API is:

```python
from app.services.translation import translation_service

hindi = translation_service.translate("Hello, how are you?")
print(hindi)
```

Empty or whitespace-only input raises `ValueError`; input that tokenizes to more than 256 source tokens raises `TranslationInputTooLongError` rather than being truncated. Model loading or inference failures raise `TranslationError` with the original exception chained for diagnosis. `POST /token-count` returns exact preprocessed tokenizer counts for up to 64 text segments with a combined 2,000-character limit. `POST /translate-batch` translates up to eight segments in one model generation call; every segment must fit the 256-token limit and the batch must fit the 2,000-character limit. `POST /translate` remains available for a single English-to-Hindi item. Invalid requests return HTTP 422, model errors return 503, and unexpected errors return 500.

## CPU performance and limitations

The development machine has 8 logical CPU cores and about 7.6 GiB RAM, with no available CUDA device. CPU inference avoids GPU dependencies but is slower than the model card's recommended GPU setup, particularly with beam search. The float32 model requires substantial memory; avoid loading multiple service instances or running concurrent model copies. Calls on one service instance are serialized; `POST /translate-batch` uses one batched model generation call for up to eight inputs.

On this machine, first-use loading including the model-file download took 47.41 seconds. A later load from the cache took 1.97 seconds. After that cached load, the three sample translations took 0.79, 1.19, and 1.44 seconds respectively. These are single-run development measurements; CPU load, cache state, and sentence length affect timings.

Observed outputs:

| English input | Hindi output |
| --- | --- |
| `Hello, how are you?` | नमस्ते, आप कैसे हैं? |
| `Artificial intelligence is changing the way people learn, work, and communicate.` | आर्टिफिशियल इंटेलिजेंस लोगों के सीखने, काम करने और संवाद करने के तरीके को बदल रहा है। |
| `Hello! Welcome to WebTranslate AI. Let's learn something new.` | नमस्ते! वेबट्रांसलेट ए. आई. में आपका स्वागत है। आइए कुछ नया सीखते हैं। |

The model is designed for sentence-level translation. Long webpage passages need to be split into sentences before translation; requests exceeding either API limit are rejected, not truncated. Translation quality can vary with context, names, idioms, and formatting, and output should be reviewed for high-stakes use.

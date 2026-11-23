# WebsiteTranslate AI

WebsiteTranslate AI is a local prototype for translating English webpage text
into Hindi. It uses a Manifest V3 Chrome extension and a FastAPI backend with
the AI4Bharat IndicTrans2 English-to-Indic Distilled 200M model.

This prototype runs locally. It does not have a public production API URL,
cloud deployment, or production hosting configuration.

## What is implemented

- Chrome extension popup with Translate Webpage and Restore Original actions.
- English-to-Hindi language selection.
- Visible, non-editable webpage text extraction.
- Preservation of original text for successful restore operations.
- A FastAPI backend with health, language, token-count, single-translation,
  and translation-batch endpoints.
- Exact IndicTrans2 token preflight and bounded batch translation.
- Request timeouts and clear partial-failure handling in the extension.
- Support for the exact Chrome extension origin through CORS.

The prototype is not a cloud service. Keep the backend running on the local
machine while using the unpacked extension.

## Requirements

Use WSL Ubuntu for the backend. The validated development environment uses:

- WSL Ubuntu 24.04
- Python 3.12
- The existing `backend/.venv` virtual environment
- CPU-only PyTorch
- An internet connection for the first Hugging Face model download
- Chrome for extension testing

The model requires substantial CPU and memory. The project documentation
records approximately 1.1 GB for the selected model cache and 1.3 GB for the
existing virtual environment. Translation is expected to be slower on CPU than
on GPU hardware.

## Beginner setup in WSL

Open a WSL Ubuntu terminal and change to the project directory:

```bash
cd /root/projects/websitetranslate-ai
```

### 1. Create or activate the backend virtual environment

For a new environment:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
```

For the existing project environment, activate it instead:

```bash
cd /root/projects/websitetranslate-ai/backend
source .venv/bin/activate
```

After activation, the terminal prompt normally shows `(.venv)`.

### 2. Install and verify Python dependencies

Install the pinned CPU and model dependencies:

```bash
python -m pip install \
  --index-url https://download.pytorch.org/whl/cpu \
  --extra-index-url https://pypi.org/simple \
  -r requirements.txt
python -m pip check
```

Do not install CUDA packages for this local CPU-only prototype.

### 3. Configure CORS

The backend uses an exact Chrome extension origin. Create the local environment
file only if it does not already exist. Run these commands from the `backend/`
directory:

```bash
cp -n .env.example .env
```

Open `.env`:

```bash
nano .env
```

Set `CORS_ORIGINS` to the exact origin reported by Chrome:

```dotenv
CORS_ORIGINS=chrome-extension://YOUR_EXTENSION_ID
```

Do not use an invented extension ID or a wildcard `chrome-extension://*`
origin. The local `.env` file is ignored by Git and must not contain an access
token.

The model repository is gated on Hugging Face. Before the first model download,
authenticate with the same Hugging Face account that has accepted model access
conditions. You can optionally verify CLI authentication with:

```bash
hf auth whoami
```

For an older Hugging Face CLI, use `huggingface-cli whoami` instead. Do not
place the Hugging Face token in this repository or in `.env`.

### 4. Start the backend

From `backend/`, load the local environment and start Uvicorn:

```bash
set -a
source .env
set +a
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

For development reload on code changes:

```bash
set -a
source .env
set +a
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

Keep this terminal open while the extension is in use.

### 5. Check that the backend is running

From another WSL terminal:

```bash
curl http://127.0.0.1:8000/health
```

Expected response:

```json
{"status":"ok"}
```

Other useful addresses:

- Swagger UI: `http://127.0.0.1:8000/docs`
- Language list: `http://127.0.0.1:8000/languages`
- OpenAPI specification: `http://127.0.0.1:8000/openapi.json`

To stop the backend normally, press `Ctrl+C` in the terminal running Uvicorn.
To restart it, run the same Uvicorn command again.

## Model cache and offline startup

The first translation may download model files from Hugging Face into the
user cache outside this repository. Typical cache locations include:

```text
~/.cache/huggingface/hub
```

The model is kept outside Git. Do not commit cache files, downloaded weights,
virtual-environment directories, or credentials.

After the model and dependencies are cached locally, start offline:

```bash
cd /root/projects/websitetranslate-ai/backend
set -a
source .env
set +a
HF_HUB_OFFLINE=1 .venv/bin/uvicorn app.main:app \
  --host 127.0.0.1 --port 8000
```

Offline mode prevents network model access. It does not hide an error if the
required model revision is missing from the cache. The model is loaded lazily
and reused across translation calls.

## Load the Chrome extension

1. Confirm `http://127.0.0.1:8000/health` works.
2. Open Chrome and visit `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select this repository's `extension/` directory.
6. Note the plain extension ID shown in the extension card. Chrome displays
   only the ID; for the backend's `.env`, use the full origin by prefixing it
   with `chrome-extension://`. The `.env` value has this form:

   ```text
   CORS_ORIGINS=chrome-extension://YOUR_EXTENSION_ID
   ```

7. If Chrome shows a different ID than the one already in `backend/.env`,
   replace `YOUR_EXTENSION_ID` in `CORS_ORIGINS` with the plain ID shown by
   Chrome:

   ```dotenv
   CORS_ORIGINS=chrome-extension://YOUR_EXTENSION_ID
   ```

8. Restart Uvicorn after changing CORS.
9. Reload the unpacked extension from `chrome://extensions` after source
   changes.
10. Open an ordinary English webpage and use the extension popup.

The extension ID can change if the extension is reinstalled or loaded in a
different Chrome profile. If CORS is not configured for the current ID,
browser requests will be rejected.

## API behavior

The local API supports:

- `GET /` - basic API response.
- `GET /health` - local backend health.
- `GET /languages` - English and Hindi language options.
- `POST /token-count` - exact IndicTrans2 preprocessed token counts.
- `POST /translate` - one English-to-Hindi text item.
- `POST /translate-batch` - bounded batch translation.

Current limits are:

- English source language: `en`
- Hindi target language: `hi`
- Maximum combined character count: 2,000
- Maximum model input: 256 tokens per item
- Maximum token-count batch: 64 text items
- Maximum translation batch: 8 text items

The backend rejects over-limit or unsupported input rather than silently
truncating it.

## Manual Chrome testing checklist

### Basic flow

- [ ] Backend `/health` returns HTTP 200.
- [ ] Swagger opens at `http://127.0.0.1:8000/docs`.
- [ ] Extension popup opens.
- [ ] Source shows English and target shows Hindi.
- [ ] Translate Webpage starts and shows progress.
- [ ] English webpage text changes to Hindi.
- [ ] Translation completed status appears.

### Page content

Test ordinary pages with:

- [ ] Short paragraphs
- [ ] Long paragraphs
- [ ] Headings
- [ ] Lists
- [ ] Punctuation
- [ ] Links
- [ ] Mixed text and page elements

Do not test login pages or sensitive personal pages.

Verify:

- [ ] Page layout is not unnecessarily changed.
- [ ] Links remain clickable.
- [ ] Buttons remain functional.
- [ ] Images are not modified.
- [ ] Scripts and styles remain untouched.
- [ ] Hidden elements are not translated.
- [ ] Editable input fields are not translated.

### Repeat and restore

- [ ] Translate the same webpage again; text does not become corrupted.
- [ ] Restore Original returns exact original text.
- [ ] Restore works after partial translation failure.
- [ ] Repeated restore leaves already restored text unchanged.
- [ ] Refreshing the page restores the page's original server content.

### Error cases

- [ ] Stop the backend and verify Backend unavailable is displayed.
- [ ] Restart the backend and retry without reloading the extension.
- [ ] Verify backend timeout produces a visible timeout or backend-unavailable
  message.
- [ ] Verify invalid or unsupported requests are not silently applied.
- [ ] Test a page with no suitable text.
- [ ] Test a very large webpage or long text segment.
- [ ] Verify failed text nodes remain unchanged.

### Browser diagnostics

If translation fails:

1. Open `chrome://extensions`.
2. Find the WebsiteTranslate AI card.
3. Open the background service worker console.
4. Inspect `/health`, `/token-count`, `/translate-batch`, or `/translate`
   failures.
5. Check the Uvicorn terminal for backend logs.
6. Reload the extension and retry after source or CORS changes.

Do not use browser-internal pages such as `chrome://extensions` or
`chrome://settings` as translation targets.

## Future production configuration

No public production API URL is configured and no cloud deployment is planned
by the current prototype.

Keep two explicit configurations separate:

1. **Local development**
   - API: `http://127.0.0.1:8000`
   - Manifest host permission: `http://127.0.0.1:8000/*`
   - CORS: exact `chrome-extension://<current-local-extension-id>`

2. **Future production, only if separately approved**
   - Use an explicit HTTPS API URL.
   - Use a separate production extension configuration.
   - Add that HTTPS origin to the manifest host permissions.
   - Set CORS to the exact production Chrome extension origin or origins.
   - Add HTTPS, environment-specific secrets, health/readiness behavior,
     structured logging, and a production process manager.
   - Do not insert placeholder public domains into the current local setup.

The future production configuration must not change the existing
`http://127.0.0.1:8000` local setup.

## Local extension packaging

For local inspection or a manual ZIP package:

1. Confirm no working file has external production configuration.
2. Package only these runtime files and directories:
   - `manifest.json`
   - `config/`
   - `popup/`
   - `scripts/`
   - `styles/`
3. Exclude:
   - `tests/`
   - `.git/`
   - virtual environments
   - model caches
   - `.env` files
   - credentials
   - build artifacts

For the current prototype, packaging is optional. Chrome's unpacked-extension
workflow is sufficient and is the documented normal setup.

A ZIP is not created automatically. If one is needed later, create it manually
from the runtime `extension/` contents and verify that no test or local secret
file is included.

Do not submit or publish this prototype in the Chrome Web Store unless
production hosting and required packaging review are separately approved.

## Run automated tests

From the repository root:

```bash
(cd backend && .venv/bin/python -m unittest discover -s tests -v)
node --test extension/tests/flow.test.cjs
```

Backend tests require the existing `backend/.venv`. Extension tests use Node.js
and do not control a real Chrome session.

## Translation model

The selected model is AI4Bharat IndicTrans2 English-to-Indic Distilled 200M,
pinned to a fixed Hugging Face revision. It supports the local prototype's
English (`eng_Latn`) to Hindi (`hin_Deva`) translation pair.

See [docs/translation-model.md](docs/translation-model.md) for model details,
license, dependencies, cache behavior, example output, and CPU limitations.

Cloud deployment and additional language pairs are outside the current local
prototype.

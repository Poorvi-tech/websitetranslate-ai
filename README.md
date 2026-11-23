# WebsiteTranslate AI

A local prototype that translates suitable English webpage text into Hindi with
the AI4Bharat IndicTrans2 English-to-Indic Distilled 200M model. The project
contains a Manifest V3 Chrome extension and a FastAPI backend. Translation
requests stay on the local machine during development.

## Implemented features

- The popup starts translation and original-text restoration for the active tab.
- The extension extracts visible, non-editable text nodes and leaves script,
  style, form-control, and other unsuitable content alone.
- The background worker checks exact model-token counts, splits oversized text,
  sends bounded translation batches, and reports progress and failures.
- Successfully translated nodes can be restored to their exact original text.
- The backend exposes `/health`, `/languages`, `/token-count`, `/translate`, and
  `/translate-batch`.

Automated tests cover the backend contracts and a mocked extension flow. The
unpacked extension's complete translate/restore flow, layout integrity, and
browser refresh behavior have not been manually verified in Chrome during this
test run; the automated harness is not a substitute for that check.

## Backend setup (WSL Ubuntu)

From the repository root, create the environment if needed and install the
CPU-only dependencies:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install \
  --index-url https://download.pytorch.org/whl/cpu \
  --extra-index-url https://pypi.org/simple \
  -r requirements.txt
python -m pip check
```

The model is gated on Hugging Face. Authenticate there and accept its access
conditions before the first download. Model files are stored in the Hugging
Face user cache, not in this repository. Do not put access tokens in project
files.

Create the local CORS configuration only if it does not already exist:

```bash
if [ ! -f .env ]; then cp .env.example .env; fi
```

Set `CORS_ORIGINS` in `.env` to the exact
`chrome-extension://<extension-id>` origin shown at `chrome://extensions`.
Without an explicit `CORS_ORIGINS`, browser cross-origin access is disabled.
Then start the API from the `backend` directory:

```bash
set -a
source .env
set +a
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

For development auto-reload, add `--reload`. To prevent Hugging Face network
access after the model is cached, prefix the command with
`HF_HUB_OFFLINE=1`.

Check `http://127.0.0.1:8000/health` and open
`http://127.0.0.1:8000/docs` for the interactive API documentation.

## Load the Chrome extension

1. Start the backend and confirm `/health` returns `{"status":"ok"}`.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select this repository's `extension/` folder.
4. Copy the extension ID into `backend/.env` as the exact
   `chrome-extension://<extension-id>` value in `CORS_ORIGINS`, then restart
   the backend if you changed it.
5. Open an ordinary English webpage, open the extension popup, and choose
   **Translate Webpage**. Use **Restore Original** to restore changed text.

The extension's local API URL is centralized in
`extension/config/api-config.js`. Its manifest grants access only to
`http://127.0.0.1:8000/*`; no API credentials are stored in extension files.

## API limits and behavior

- Only English (`en`) to Hindi (`hi`) is supported.
- `/token-count` accepts at most 64 items and 2,000 combined characters.
- `/translate-batch` accepts at most 8 items and 2,000 combined characters;
  each item must fit the model's 256-token input limit.
- `/translate` remains available for a single text item with the same
  character and token limits.
- Inputs are rejected or split before translation; they are not silently
  truncated.
- The extension skips hidden and editable content. It changes text-node values,
  not page markup, links, images, scripts, or styles.
- A page refresh reloads the website's original content; translation records
  are in memory and do not persist across reloads.
- The CPU model can be slow on pages with thousands of text segments. Network
  calls time out with an error; failed or invalid batches remain unchanged.
- Browser-internal pages and other protected pages cannot be modified by
  extensions.

## Run automated tests

From the repository root:

```bash
(cd backend && .venv/bin/python -m unittest discover -s tests -v)
node --test extension/tests/flow.test.cjs
```

These tests do not install or control Chrome. Verify translation, restore,
refresh, links/buttons, and backend/network failure behavior manually in the
unpacked extension before treating the prototype as browser-verified.

## Translation model

See [docs/translation-model.md](docs/translation-model.md) for the model
revision, license, inference workflow, dependencies, and CPU limitations.

Cloud deployment and additional language pairs are outside the current
prototype.

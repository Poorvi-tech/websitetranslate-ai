# WebsiteTranslate AI

## Project overview

WebsiteTranslate AI is a prototype Chrome extension designed to translate English webpage content into Hindi. The project combines a browser extension interface with a Python backend and a pre-trained open-source machine translation model.

The repository contains an early Chrome extension and a minimal backend API. Translation and end-to-end integration are still planned.

## Objective

Build a simple, end-to-end webpage translation experience where a user activates the extension and relevant text from the current webpage is translated from English to Hindi.

The prototype is intended to demonstrate:

- Browser extension fundamentals.
- Communication between a Chrome extension and a Python backend.
- Use of a pre-trained open-source translation model.
- A clear progression from a proof of concept to a usable application.

## Initial features

Planned features for the first working prototype:

- A Chrome extension popup.
- Manual activation of English-to-Hindi translation.
- Page text extraction through extension scripts.
- Translation requests sent to a Python backend.
- Hindi text returned and presented on the webpage.
- Basic loading and error states.

## Planned technology stack

- **Browser extension:** Manifest V3, JavaScript, HTML, and CSS.
- **Backend:** Python and FastAPI.
- **Translation model:** Pre-trained open-source English-to-Hindi translation model.
- **API:** REST endpoints served by FastAPI.
- **Development tools:** Git, GitHub, VS Code, and Python package tooling.

The translation model will be selected during implementation.

## High-level architecture

```text
User
  |
  v
Chrome Extension Popup
  |
  v
Content Script / Page Text Extraction
  |
  v
Backend API
  |
  v
Pre-trained Translation Model
  |
  v
Hindi Translation Response
  |
  v
Updated Browser Page
```

The extension handles user interaction and webpage integration. The backend exposes an API and manages translation-model requests. The model performs the English-to-Hindi translation.

## Backend development

The FastAPI backend is developed and run inside WSL. From the repository root:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
```

In `.env`, replace `YOUR_EXTENSION_ID` with the ID shown for the unpacked extension at `chrome://extensions`. Load the settings and start the API:

```bash
set -a
source .env
set +a
uvicorn app.main:app --reload
```

The initial API provides `GET /`, `GET /health`, and `GET /languages`; the languages response lists English (`en`) and Hindi (`hi`). Interactive API documentation is available at `/docs`. Run the endpoint tests with `python -m unittest discover -s tests`.

`CORS_ORIGINS` is a comma-separated allowlist of exact origins; it does not enable wildcard origins or credentials. During extension integration, configure the extension's exact `chrome-extension://<extension-id>` origin in this setting. The extension ID may differ between development installations, so use the ID shown in Chrome rather than a guessed value.

## Development roadmap

1. Initialize the repository and project structure.
2. Create the Chrome extension manifest and popup.
3. Implement secure text extraction from webpages.
4. Build a minimal Python backend API.
5. Integrate and test a pre-trained translation model.
6. Connect the extension to the backend.
7. Add loading, error, and unsupported-page handling.
8. Test translation quality and browser behavior.
9. Document setup and usage instructions.

## Current status

**Phase 4 — initial FastAPI backend**

- The repository structure is established.
- README and Python/browser/VS Code/OS ignore rules are added.
- A Manifest V3 extension shell with a popup, content script, and background service worker is available.
- Popup-to-background-to-content-script communication can extract readable text and restore preserved text.
- Text extraction skips unsuitable and hidden elements and preserves node-to-original-text mappings.
- A minimal FastAPI backend exposes root, health, and English/Hindi language-list endpoints.
- Backend dependencies, virtual environment, endpoint tests, and exact-origin CORS configuration are set up for WSL development.
- Translation-model integration and extension-to-backend API connection have not been implemented.

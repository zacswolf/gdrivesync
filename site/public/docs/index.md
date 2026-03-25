# GDriveSync Docs

GDriveSync is a VS Code extension and agent-friendly CLI for pulling Google Drive files into normal local files.

## What it does

- Google Docs and DOCX -> Markdown
- Google Slides and PPTX -> Marp-flavored Markdown
- Google Sheets and XLSX -> CSV or a folder of CSVs
- Extracts image assets into their own local files when applicable
- Maintains a local `.gdrivesync.json` manifest for file bindings and sync state

## Core model

GDriveSync is one-way by design. Google Drive stays the source of truth, and the local side stays optimized for normal tools, editors, and agents.

## VS Code extension

- Connect Google accounts with desktop OAuth
- Link the current file or import a new one from Google
- Sync the current file or all linked files
- Use CodeLens, status bar, and editor/explorer commands
- Configure optional image enrichment for Markdown and Marp outputs

## CLI

Main commands:

```bash
gdrivesync auth login
gdrivesync inspect <google-file-url-or-id> --json
gdrivesync export <google-file-url-or-id> ./deck.md --json
gdrivesync link <google-file-url-or-id> ./notes/spec.md --cwd ./data --json
gdrivesync status --all --cwd ./data --json
gdrivesync sync --all --cwd ./data --json
gdrivesync doctor --cwd ./data --json --repair
```

## Auth and hosting

- Desktop sign-in uses a localhost callback and does not require the hosted picker site
- Picker-based selection and some shared-link recovery flows use the hosted site on this domain

## Image enrichment

- Local OCR prefers Apple Vision on macOS and falls back to Tesseract when available
- Optional cloud image enrichment uses user-supplied OpenAI or Anthropic credentials directly from the user's machine
- No image enrichment data is routed through a GDriveSync-operated backend

## Known limits

- One-way sync only
- Very large native Google Slides decks may fall back to the Google Slides API path

## Machine-friendly references

- Homepage: `/`
- Privacy: `/privacy`
- Docs HTML: `/docs/`
- LLM index: `/llms.txt`
- Full LLM text: `/llms-full.txt`

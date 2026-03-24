# GDriveSync

GDriveSync is a Google Drive to local-file bridge for humans and agents.

Use it in VS Code when you want linked files that stay native to your workspace. Use the CLI when you want an agent-safe way to inspect and export Google Docs, DOCX, Google Slides, PowerPoint, Google Sheets, and XLSX into normal Markdown, Marp-flavored Markdown, or CSV outputs.

Core flows:
- Google Docs -> `.md`
- DOCX in Drive -> `.md`
- Google Slides -> Marp-flavored `.md`
- PowerPoint in Drive -> Marp-flavored `.md`
- Google Sheets -> `.csv` or `folder-of-csvs`
- XLSX in Drive -> `.csv` or `folder-of-csvs`

The project is one-way by design: Google Drive is the source of truth.

## Why this matters for agents

Most agents still integrate through CLIs, not editor extensions. GDriveSync is useful there because it gives agents a clean bridge from Google Drive into normal local files they already know how to read and edit.

Agent-friendly qualities:
- OAuth-backed access instead of brittle browser scraping
- stable local outputs: Markdown and CSV
- direct export to stdout for single-file workflows
- first-class manifest-aware `link`, `status`, `sync`, and `unlink` commands
- machine-readable command envelopes with a stable `contractVersion` and `ok/data` or `ok/error` shape under `--json`
- explicit workspace targeting with `--cwd`
- a `doctor` command for auth/manifest diagnostics and corruption recovery
- predictable spreadsheet shape switching:
  - one visible sheet -> `report.csv`
  - multiple visible sheets -> `report/<sheet>.csv`

## What is implemented

- VS Code extension in TypeScript
- Google OAuth desktop flow with PKCE and VS Code `SecretStorage`
- Desktop OAuth uses a localhost loopback callback inside the extension
- Google Docs export to `.docx` and local DOCX -> Markdown conversion for higher-resolution images
- DOCX-in-Drive download and local DOCX -> Markdown conversion
- Google Slides export to `.pptx` and local Marp Markdown generation
- Automatic Google Slides API fallback for oversized native Slides decks when Drive export is too large
- Drive-hosted `.pptx` download and local Marp Markdown generation
- Google Sheets export to `.xlsx` and local `.csv` generation
- Drive-hosted `.xlsx` download and local `.csv` generation
- Optional local image enrichment for Markdown and Marp outputs using Apple Vision on macOS or Tesseract when available
- Workspace sidecar manifest in `.gdrivesync.json`
- Commands for connecting accounts, switching the default account, linking, importing, syncing, auto-sync toggle, unlinking, and disconnecting accounts
- Progress notifications for manual import and sync flows in the VS Code extension
- Status bar, CodeLens, and editor/explorer command contributions for linked Markdown and CSV files
- Static site assets for Cloudflare Pages, including homepage, privacy policy, bridge page, and Picker page
- Agent-friendly CLI entrypoint with auth, inspect, export, link, status, sync, and unlink flows
- Internal sync profiles so Docs/DOCX can share one Markdown flow, Slides/PPTX can share one Marp flow, and Sheets/XLSX can share one CSV flow
- Automatic spreadsheet shape switching:
  - one visible sheet -> `report.csv`
  - multiple visible sheets -> `report/<sheet>.csv`

## Project layout

- `src/` extension, sync core, and CLI
- `site/public/` static site assets for Cloudflare Pages
- `test/unit/` Vitest unit coverage for parsing, hashing, manifest validation, and sync policy

## Local development

1. Install dependencies:

```bash
npm install
```

2. Add your Google desktop OAuth config while developing. The easiest path is a local git-ignored `.env` file in the repo root:

```bash
cp .env.example .env
```

Then fill in:

- `GDOCSYNC_DESKTOP_CLIENT_ID`
- `GDOCSYNC_DESKTOP_CLIENT_SECRET`
- optionally `GDOCSYNC_HOSTED_BASE_URL` for non-production site testing

The extension automatically loads `.env` and `.env.local` from the repo root in development.

You can also set these via:

- VS Code setting: `gdocSync.development.desktopClientId`
- VS Code setting: `gdocSync.development.desktopClientSecret`
- Or shell env: `GDOCSYNC_DESKTOP_CLIENT_ID`
- Or shell env: `GDOCSYNC_DESKTOP_CLIENT_SECRET`

3. If you are testing against a non-production hosted site, also set:

- VS Code setting: `gdocSync.development.hostedBaseUrl`
- Shell env: `GDOCSYNC_HOSTED_BASE_URL`
- Or `GDOCSYNC_HOSTED_BASE_URL` in `.env.local`

4. Build and test:

```bash
npm run compile
npm test
```

5. Launch the extension in VS Code with `F5`.

## Google Cloud setup

Start with one Google Cloud project for both the extension and the hosted picker site. If the app grows and the release workflow gets more complex later, you can split development and production projects at that point.

- Enable Google Drive API
- Create a desktop OAuth client for the extension
- Create a web OAuth client for the hosted picker page
- Configure the consent screen homepage as `https://gdrivesync.zacswolf.com/`
- Configure the privacy policy as `https://gdrivesync.zacswolf.com/privacy`
- Verify the authorized domain for `zacswolf.com`

The extension only needs the desktop client ID. The hosted site needs:

- web client ID
- browser API key
- Google Cloud project number

Keep [site/public/site-config.js](/Users/zacschulwolf/Programming/gdocs_sync_vscode_extension/site/public/site-config.js) as a placeholder in git. The production browser API key is injected during GitHub Actions deploys from the `GDOCSYNC_PICKER_API_KEY` secret.

## Cloudflare Pages deployment

Deploy [site/public](/Users/zacschulwolf/Programming/gdocs_sync_vscode_extension/site/public) as a static site on Cloudflare Pages and bind it to `gdrivesync.zacswolf.com`.

This repo includes a GitHub Actions deploy workflow in [.github/workflows/deploy-pages.yml](/Users/zacschulwolf/Programming/gdocs_sync_vscode_extension/.github/workflows/deploy-pages.yml). Once the Cloudflare Pages project exists and the `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `GDOCSYNC_PICKER_API_KEY` secrets are set in GitHub, pushes to `main` will redeploy the site automatically.

Required routes:

- `/`
- `/privacy`
- `/picker`

No Worker is required for v1.

## CLI

The CLI is a core interface for this project, not a sidecar dev script.

Current command set:

```bash
gdrivesync auth login
gdrivesync auth logout --account <account>
gdrivesync auth logout --all
gdrivesync auth list [--json]
gdrivesync auth use <account> [--json]
gdrivesync auth status [--json]
gdrivesync doctor [--cwd path] [--json] [--repair]
gdrivesync inspect <google-file-url-or-id> [--json]
gdrivesync metadata <google-file-url-or-id> [--json]
gdrivesync export <google-file-url-or-id> [output-path] [--json] [--include-backgrounds] [--image-enrichment off|local] [--image-enrichment-provider auto|apple-vision|tesseract] [--image-enrichment-store alt-plus-comment|alt-only]
gdrivesync link <google-file-url-or-id> <local-path> [--cwd path] [--json] [--force] [--image-enrichment off|local] [--image-enrichment-provider auto|apple-vision|tesseract] [--image-enrichment-store alt-plus-comment|alt-only]
gdrivesync status <local-path> [--cwd path] [--json]
gdrivesync status --all [--cwd path] [--json]
gdrivesync sync <local-path> [--cwd path] [--json] [--force] [--image-enrichment off|local] [--image-enrichment-provider auto|apple-vision|tesseract] [--image-enrichment-store alt-plus-comment|alt-only]
gdrivesync sync --all [--cwd path] [--json] [--force] [--image-enrichment off|local] [--image-enrichment-provider auto|apple-vision|tesseract] [--image-enrichment-store alt-plus-comment|alt-only]
gdrivesync unlink <local-path> [--cwd path] [--json] [--remove-generated]
```

Key CLI behaviors:
- `auth login` connects a Google account; connecting the same account again refreshes its saved session
- `auth list` and `auth use` expose the multi-account model explicitly for agents
- `auth logout` requires `--account` or `--all`
- `link` immediately creates the manifest entry and runs an initial sync
- `link` binds the local file to the account that successfully read the source file
- pasted-link imports probe the default connected account first, then other connected accounts
- every `--json` response uses a top-level envelope with `ok`, `contractVersion`, `command`, and either `data` or `error`
- `status --all --json` returns manifest-aware file metadata for the whole workspace
- `sync --all --json` returns per-file results with `synced`, `skipped`, `cancelled`, or `failed`
- `sync` and `link` return a non-zero exit code when they are cancelled or fail
- top-level command failures stay machine-readable in `--json` mode with stable error codes
- `export` writes to stdout when no output path is given, and writes files when one is provided
- oversized native Google Slides decks that fall back to the Slides API omit slide background images by default; use `--include-backgrounds` if you want them
- CLI image enrichment stays explicit and local-only; use `--image-enrichment local` when you want OCR-based image alt-text improvements for Markdown or Marp outputs
- `doctor --repair` backs up corrupt CLI auth or manifest state before restoring a working baseline

Examples:

```bash
npm run cli -- auth login
npm run cli -- auth list --json
npm run cli -- auth use me@example.com --json
npm run cli -- auth status --json
npm run cli -- auth logout --account me@example.com --json
npm run cli -- doctor --cwd ./data --json
npm run cli -- doctor --cwd ./data --json --repair
npm run cli -- inspect https://docs.google.com/document/d/<file-id>/edit --json
npm run cli -- export https://docs.google.com/document/d/<file-id>/edit
npm run cli -- export https://docs.google.com/presentation/d/<file-id>/edit ./deck.md --json
npm run cli -- export https://docs.google.com/presentation/d/<file-id>/edit ./deck.md --image-enrichment local --json
npm run cli -- export https://docs.google.com/spreadsheets/d/<file-id>/edit ./sheet.csv --json
npm run cli -- link https://docs.google.com/document/d/<file-id>/edit ./notes/spec.md --cwd ./data --json
npm run cli -- status --all --cwd ./data --json
npm run cli -- sync ./notes/spec.md --cwd ./data --json
npm run cli -- sync ./slides/deck.md --cwd ./data --image-enrichment local --json
npm run cli -- sync --all --cwd ./data --json
npm run cli -- unlink ./notes/spec.md --cwd ./data --json
```

Example `inspect --json` output:

```json
{
  "ok": true,
  "contractVersion": 1,
  "command": "inspect",
  "data": {
    "fileId": "abc123",
    "title": "Quarterly Planning",
    "sourceMimeType": "application/vnd.google-apps.spreadsheet",
    "sourceUrl": "https://docs.google.com/spreadsheets/d/abc123/edit",
    "profileId": "google-sheet-csv",
    "sourceTypeLabel": "Spreadsheet",
    "targetFamily": "csv",
    "targetFileExtension": "csv",
    "retrievalMode": "drive-export-xlsx"
  }
}
```

Example `sync --all --json` output shape:

```json
{
  "ok": true,
  "contractVersion": 1,
  "command": "sync",
  "data": {
    "rootPath": "/workspace/data",
    "manifestPath": "/workspace/data/.gdrivesync.json",
    "results": [
      {
        "file": "/workspace/data/spec.md",
        "outcome": {
          "status": "synced",
          "message": "Synced spec.md."
        }
      },
      {
        "file": "/workspace/data/report.csv",
        "outcome": {
          "status": "skipped",
          "message": "Remote version unchanged."
        }
      }
    ],
    "syncedCount": 1,
    "skippedCount": 1,
    "cancelledCount": 0,
    "failedCount": 0
  }
}
```

Example `doctor --json` output shape:

```json
{
  "ok": true,
  "contractVersion": 1,
  "command": "doctor",
  "data": {
    "rootPath": "/workspace/data",
    "manifest": {
      "path": "/workspace/data/.gdrivesync.json",
      "exists": true,
      "valid": true,
      "linkedFileCount": 8,
      "droppedInvalidEntryCount": 0,
      "missingPrimaryFileCount": 0,
      "missingGeneratedFileCount": 0
    },
    "auth": {
      "tokenPath": "/Users/me/.gdrivesync-dev-session.json",
      "sessionFileExists": true,
      "authenticated": true,
      "sessionValid": true,
      "accountCount": 2,
      "refreshTokenPresent": true,
      "scopeMatchesConfig": true,
      "defaultAccountId": "perm-123",
      "defaultAccountEmail": "me@example.com",
      "accounts": [
        {
          "accountId": "perm-123",
          "accountEmail": "me@example.com",
          "isDefault": true
        },
        {
          "accountId": "perm-456",
          "accountEmail": "work@example.com",
          "isDefault": false
        }
      ]
    },
    "imageEnrichment": {
      "mode": "off",
      "cacheRootPath": "/Users/me/Library/Caches/GDriveSync",
      "appleVision": {
        "available": true,
        "compilerAvailable": true,
        "helperSourceExists": true,
        "status": "compiled"
      },
      "tesseract": {
        "available": true,
        "path": "/opt/homebrew/bin/tesseract"
      }
    },
    "issues": [],
    "repair": {
      "attempted": false,
      "performed": false,
      "actions": []
    }
  }
}
```

If you are building agent integrations, prefer:
- `--json` for anything you plan to parse
- `--cwd` instead of relying on implicit working-directory state
- `export` for ephemeral reads
- `link` + `sync` for durable workspace state
- `status --all --json` before `sync --all --json` when you want to reason about what will be touched

There is also a short agent-focused usage guide in [docs/agent-cli.md](/Users/zacschulwolf/Programming/gdocs_sync_vscode_extension/docs/agent-cli.md).

## Local image enrichment

GDriveSync can optionally improve generated Markdown and Marp image alt text using local OCR. This is a local-only feature in v1: no image bytes are uploaded to GDriveSync servers or third-party APIs.

Default behavior:
- VS Code extension: `gdocSync.imageEnrichment.mode = prompt`
- CLI: image enrichment stays off unless you pass `--image-enrichment local`

Supported outputs:
- Markdown from Google Docs and DOCX
- Marp-flavored Markdown from Google Slides and PowerPoint
- CSV outputs are not affected

Provider order:
- macOS prefers Apple Vision when the local helper can be compiled
- otherwise GDriveSync uses `tesseract` if it is installed
- otherwise sync/export falls back to the current no-enrichment behavior

Extension settings:
- `gdocSync.imageEnrichment.mode`: `prompt | off | local`
- `gdocSync.imageEnrichment.provider`: `auto | apple-vision | tesseract`
- `gdocSync.imageEnrichment.store`: `alt-plus-comment | alt-only`
- `gdocSync.imageEnrichment.onlyWhenAltGeneric`: only enrich generic generated alt text

When enabled, GDriveSync can rewrite generic image alt text and optionally append compact OCR metadata comments like:

```md
![Comparison graphic: Hairburst vs drugstore multivitamin](./deck.assets/slide-23-image-1.png)
<!-- gdrivesync:image-meta {"v":1,"hash":"sha256:...","source":"apple-vision","ocr":"HAIR BURST ... MULTIVITAMIN"} -->
```

The OCR cache is per-user and keyed by image hash, so unchanged assets are not reprocessed on every sync.

## Multi-account behavior

GDriveSync supports multiple connected Google accounts in both the extension and the CLI.

Extension account commands:
- `Connect Google Account...`
- `Disconnect Google Account...`
- `Switch Default Google Account`
- `Google Accounts`

Default account behavior:
- pasted Google file URLs try the default connected account first, then other connected accounts
- Google Picker is explicit: if multiple accounts are connected, you choose which one to use
- linked files stay pinned to their bound Google account unless that account becomes unusable
- if a bound account is broken and another connected account can read the file, GDriveSync can recover and rebind it because sync is one-way

## State recovery

If the CLI manifest or saved CLI OAuth session gets corrupted, GDriveSync now fails with explicit machine-readable error codes instead of a raw JSON parse stack. The supported recovery path is:

```bash
gdrivesync doctor --cwd ./workspace --json
gdrivesync doctor --cwd ./workspace --repair
```

`doctor --repair` backs up corrupt local CLI state before restoring a working baseline:
- corrupt `.gdrivesync.json` manifests are backed up and replaced with a clean manifest, preserving valid entries when possible
- corrupt CLI OAuth state files are backed up and cleared so you can reconnect cleanly

The VS Code extension uses SecretStorage instead of the CLI auth file. If that state ever becomes corrupted, disconnecting and reconnecting the affected Google account is the intended repair path.

## Distribution plans

Planned distribution targets:
- VS Code Marketplace
- Open VSX
- Homebrew

The CLI is intended to be a real integration surface for agent builders, not just a local developer helper.

## Current limitations

- One-way sync only: Google files -> local Markdown, Marp Markdown, or CSV
- The hosted Picker fallback is still used as a backup if direct pasted-link access fails
- Formatting fidelity depends on local DOCX conversion for native Docs and Word files, local presentation parsing for Slides/PPTX, and local workbook parsing for Sheets/XLSX
- Presentation sync targets Marp-flavored Markdown and focuses on slide text plus extracted images rather than full visual layout fidelity
- Very large native Google Slides decks may bypass Drive export and use the Google Slides API fallback automatically
- Spreadsheet sync only supports native Google Sheets and `.xlsx` in v1
- Image enrichment in v1 is local OCR only; it does not provide semantic image captioning beyond OCR-derived summaries
- Apple Vision enrichment requires macOS plus local Swift compiler availability; otherwise GDriveSync falls back to Tesseract when installed
- Linked files must live inside an open VS Code workspace folder

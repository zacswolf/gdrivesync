# GDriveSync for VS Code

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
- machine-readable `inspect`, `status`, `sync`, and `export` output with `--json`
- explicit workspace targeting with `--cwd`
- predictable spreadsheet shape switching:
  - one visible sheet -> `report.csv`
  - multiple visible sheets -> `report/<sheet>.csv`

## What is implemented

- Desktop VS Code extension scaffold in TypeScript
- Google OAuth desktop flow with PKCE and VS Code `SecretStorage`
- Desktop OAuth uses a localhost loopback callback inside the extension
- Google Drive export to `text/markdown`
- DOCX-in-Drive download and local DOCX -> Markdown conversion
- Google Slides export to `.pptx` and local Marp Markdown generation
- Automatic Google Slides API fallback for oversized native Slides decks when Drive export is too large
- Drive-hosted `.pptx` download and local Marp Markdown generation
- Google Sheets export to `.xlsx` and local `.csv` generation
- Drive-hosted `.xlsx` download and local `.csv` generation
- Workspace sidecar manifest in `.gdrivesync.json`
- Commands for sign-in, linking, importing, syncing, auto-sync toggle, unlinking, and sign-out
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
gdrivesync auth logout
gdrivesync auth status [--json]
gdrivesync inspect <google-file-url-or-id> [--json]
gdrivesync metadata <google-file-url-or-id> [--json]
gdrivesync export <google-file-url-or-id> [output-path] [--json] [--include-backgrounds]
gdrivesync link <google-file-url-or-id> <local-path> [--cwd path] [--json] [--force]
gdrivesync status <local-path> [--cwd path] [--json]
gdrivesync status --all [--cwd path] [--json]
gdrivesync sync <local-path> [--cwd path] [--json] [--force]
gdrivesync sync --all [--cwd path] [--json] [--force]
gdrivesync unlink <local-path> [--cwd path] [--json] [--remove-generated]
```

Key CLI behaviors:
- `link` immediately creates the manifest entry and runs an initial sync
- `status --all --json` returns manifest-aware file metadata for the whole workspace
- `sync --all --json` returns per-file results with `synced`, `skipped`, `cancelled`, or `failed`
- `sync` and `link` return a non-zero exit code when they are cancelled or fail
- top-level command failures stay machine-readable in `--json` mode
- `export` writes to stdout when no output path is given, and writes files when one is provided
- oversized native Google Slides decks that fall back to the Slides API omit slide background images by default; use `--include-backgrounds` if you want them

Examples:

```bash
npm run cli -- auth login
npm run cli -- auth status --json
npm run cli -- inspect https://docs.google.com/document/d/<file-id>/edit --json
npm run cli -- export https://docs.google.com/document/d/<file-id>/edit
npm run cli -- export https://docs.google.com/presentation/d/<file-id>/edit ./deck.md --json
npm run cli -- export https://docs.google.com/spreadsheets/d/<file-id>/edit ./sheet.csv --json
npm run cli -- link https://docs.google.com/document/d/<file-id>/edit ./notes/spec.md --cwd ./data --json
npm run cli -- status --all --cwd ./data --json
npm run cli -- sync ./notes/spec.md --cwd ./data --json
npm run cli -- sync --all --cwd ./data --json
npm run cli -- unlink ./notes/spec.md --cwd ./data --json
```

Example `inspect` output:

```json
{
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
```

Example `sync --all --json` output shape:

```json
{
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
```

If you are building agent integrations, prefer:
- `--json` for anything you plan to parse
- `--cwd` instead of relying on implicit working-directory state
- `export` for ephemeral reads
- `link` + `sync` for durable workspace state
- `status --all --json` before `sync --all --json` when you want to reason about what will be touched

There is also a short agent-focused usage guide in [docs/agent-cli.md](/Users/zacschulwolf/Programming/gdocs_sync_vscode_extension/docs/agent-cli.md).

## Distribution plans

Planned distribution targets:
- VS Code Marketplace
- Open VSX
- Homebrew

Publishing a short best-practices doc for agent usage is not dumb at all. It is probably a very good idea once the CLI surface settles a bit, because that is how other agent builders will actually discover the right workflows.

## Current limitations

- One-way sync only: Google files -> local Markdown, Marp Markdown, or CSV
- The extension now uses `drive.readonly` for one-way sync, so existing local sessions may need a one-time reconnect after upgrades
- The hosted Picker fallback is still used as a backup if direct pasted-link access fails
- Formatting fidelity depends on Google’s Markdown export for native Docs, local DOCX conversion for Word files, local presentation parsing for Slides/PPTX, and local workbook parsing for Sheets/XLSX
- Presentation sync targets Marp-flavored Markdown and focuses on slide text plus extracted images rather than full visual layout fidelity
- Very large native Google Slides decks may bypass Drive export and use the Google Slides API fallback automatically
- Spreadsheet sync only supports native Google Sheets and `.xlsx` in v1
- Linked files must live inside an open VS Code workspace folder

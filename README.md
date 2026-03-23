# GDriveSync for VS Code

GDriveSync is a Google Drive to local-file bridge for humans and agents.

Use it in VS Code when you want linked files that stay native to your workspace. Use the CLI when you want an agent-safe way to inspect and export Google Docs, DOCX, Google Sheets, and XLSX into normal Markdown or CSV outputs.

Core flows:
- Google Docs -> `.md`
- DOCX in Drive -> `.md`
- Google Sheets -> `.csv` or `folder-of-csvs`
- XLSX in Drive -> `.csv` or `folder-of-csvs`

The project is one-way by design: Google Drive is the source of truth.

## Why this matters for agents

Most agents still integrate through CLIs, not editor extensions. GDriveSync is useful there because it gives agents a clean bridge from Google Drive into normal local files they already know how to read and edit.

Agent-friendly qualities:
- OAuth-backed access instead of brittle browser scraping
- stable local outputs: Markdown and CSV
- direct export to stdout for single-file workflows
- machine-readable `inspect` output
- optional JSON export summaries when writing files
- predictable spreadsheet shape switching:
  - one visible sheet -> `report.csv`
  - multiple visible sheets -> `report/<sheet>.csv`

## What is implemented

- Desktop VS Code extension scaffold in TypeScript
- Google OAuth desktop flow with PKCE and VS Code `SecretStorage`
- Desktop OAuth uses a localhost loopback callback inside the extension
- Google Drive export to `text/markdown`
- DOCX-in-Drive download and local DOCX -> Markdown conversion
- Google Sheets export to `.xlsx` and local `.csv` generation
- Drive-hosted `.xlsx` download and local `.csv` generation
- Workspace sidecar manifest in `.gdrivesync.json`
- Commands for sign-in, linking, importing, syncing, auto-sync toggle, unlinking, and sign-out
- Status bar, CodeLens, and editor/explorer command contributions for linked Markdown and CSV files
- Static site assets for Cloudflare Pages, including homepage, privacy policy, bridge page, and Picker page
- Agent-friendly CLI entrypoint with inspect/export flows
- Internal sync profiles so Docs/DOCX can share one Markdown flow and Sheets/XLSX can share one CSV flow
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

The CLI is now an important part of the product, especially for agent workflows.

Current strengths:
- inspect a Drive file and get machine-readable output
- export a supported file directly to stdout
- export to a local Markdown file
- export spreadsheets to a single CSV or a generated folder of CSVs
- return JSON write summaries when `--json` is used with file exports

Examples:

```bash
npm run cli -- sign-in
npm run cli -- inspect https://docs.google.com/document/d/<file-id>/edit
npm run cli -- export https://drive.google.com/file/d/<file-id>/view ./file.md
npm run cli -- export https://docs.google.com/spreadsheets/d/<file-id>/edit ./sheet.csv
npm run cli -- export https://docs.google.com/spreadsheets/d/<file-id>/edit ./sheet.csv --json
```

Example `inspect` output shape:

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

Near-term CLI roadmap:
- stable top-level `gdrivesync` install path for package managers
- more explicit JSON modes for scripting
- better batch/export ergonomics for agent runs
- clearer auth/session diagnostics

## Distribution plans

Planned distribution targets:
- VS Code Marketplace
- Open VSX
- Homebrew

Publishing a short best-practices doc for agent usage is not dumb at all. It is probably a very good idea once the CLI surface settles a bit, because that is how other agent builders will actually discover the right workflows.

## Current limitations

- One-way sync only: Google files -> local Markdown or CSV
- The extension now uses `drive.readonly` for one-way sync, so existing local sessions may need a one-time reconnect after upgrades
- The hosted Picker fallback is still used as a backup if direct pasted-link access fails
- Formatting fidelity depends on Google’s Markdown export for native Docs, local DOCX conversion for Word files, and local workbook parsing for Sheets/XLSX
- Spreadsheet sync only supports native Google Sheets and `.xlsx` in v1
- Linked files must live inside an open VS Code workspace folder

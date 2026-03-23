# GDriveSync for VS Code

One-way Google Docs to Markdown sync for VS Code. Link a Google Doc to a normal `.md` file, then sync on demand or when the file opens.

## What is implemented

- Desktop VS Code extension scaffold in TypeScript
- Google OAuth desktop flow with PKCE and VS Code `SecretStorage`
- Hosted OAuth bridge flow via `https://gdrivesync.zacswolf.com/oauth/google/bridge`
- Google Drive export to `text/markdown`
- Workspace sidecar manifest in `.gdocsync.json`
- Commands for sign-in, linking, importing, syncing, auto-sync toggle, unlinking, and sign-out
- Status bar and editor/explorer command contributions for Markdown files
- Static site assets for Cloudflare Pages, including homepage, privacy policy, bridge page, and Picker page
- Thin CLI harness for local auth/export testing

## Project layout

- `src/` extension, sync core, and CLI
- `site/public/` static site assets for Cloudflare Pages
- `test/unit/` Vitest unit coverage for parsing, hashing, manifest validation, and sync policy

## Local development

1. Install dependencies:

```bash
npm install
```

2. Add your Google desktop OAuth client ID while developing:

- VS Code setting: `gdocSync.development.desktopClientId`
- Or shell env: `GDOCSYNC_DESKTOP_CLIENT_ID`

3. If you are testing against a non-production hosted site, also set:

- VS Code setting: `gdocSync.development.hostedBaseUrl`
- Or shell env: `GDOCSYNC_HOSTED_BASE_URL`

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

Update [site/public/site-config.js](/Users/zacschulwolf/Programming/gdocs_sync_vscode_extension/site/public/site-config.js) before deploying.

## Cloudflare Pages deployment

Deploy [site/public](/Users/zacschulwolf/Programming/gdocs_sync_vscode_extension/site/public) as a static site on Cloudflare Pages and bind it to `gdrivesync.zacswolf.com`.

This repo includes a GitHub Actions deploy workflow in [.github/workflows/deploy-pages.yml](/Users/zacschulwolf/Programming/gdocs_sync_vscode_extension/.github/workflows/deploy-pages.yml). Once the Cloudflare Pages project exists and the `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` secrets are set in GitHub, pushes to `main` will redeploy the site automatically.

Required routes:

- `/`
- `/privacy`
- `/oauth/google/bridge`
- `/picker`

No Worker is required for v1.

## CLI

The CLI is for development and debugging, not for end users.

```bash
npm run cli -- sign-in
npm run cli -- metadata https://docs.google.com/document/d/<doc-id>/edit
npm run cli -- export https://docs.google.com/document/d/<doc-id>/edit ./doc.md
```

## Current limitations

- One-way sync only: Google Docs -> Markdown
- `drive.file` access means pasted doc IDs may still need one Picker-open round trip
- Formatting fidelity depends on Google’s Markdown export
- Linked files must live inside an open VS Code workspace folder

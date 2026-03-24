# Development

This guide is for local development, your own Google Cloud project, and your own hosted picker site.

For generic public-release steps, use [release-checklist.md](release-checklist.md). Keep personal production details in a private, gitignored maintainer notes file instead of this guide.

## Local quickstart

1. Install dependencies:

```bash
npm install
```

2. Copy the example environment file:

```bash
cp .env.example .env
```

3. Configure local development values:

- `GDRIVESYNC_DESKTOP_CLIENT_ID`
- `GDRIVESYNC_DESKTOP_CLIENT_SECRET`
- optionally `GDRIVESYNC_HOSTED_BASE_URL` if you are testing against your own hosted picker site
- optionally `GDRIVESYNC_LOGIN_HINT` to reduce repeated account selection during development
- optionally `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` if you want to test CLI cloud image enrichment without using keychain login

The extension only loads `.env` and `.env.local` in VS Code development/test hosts.

You can also set local overrides through VS Code user settings:

- `gdocSync.development.desktopClientId`
- `gdocSync.development.desktopClientSecret`
- `gdocSync.development.hostedBaseUrl`
- `gdocSync.development.loginHint`

Important distinction:
- desktop sign-in uses the extension's localhost callback
- `GDRIVESYNC_HOSTED_BASE_URL` is only for hosted picker flows and hosted link-share recovery
- extension cloud provider keys are stored in VS Code `SecretStorage`, not in `.env`
- CLI cloud provider keys can come from `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` or from `gdrivesync ai auth login <provider>`
- installed `gdrivesync` does not auto-load `.env`; repo-local `npm run cli -- ...` keeps that convenience for development only

4. Build and test:

```bash
npm run compile
npm test
```

5. Launch the extension in VS Code with `F5`.

## Google Cloud project setup

Start with one Google Cloud project for both the extension and the hosted picker site. You can split development and production projects later if you need stronger separation.

Create:

- a desktop OAuth client for the extension
- a web OAuth client for the hosted picker site
- a browser API key for the hosted picker page

Enable:

- Google Drive API

Recommended consent screen setup:

- homepage: your deployed public GDriveSync site
- privacy policy: your deployed public privacy page
- authorized domain: the domain that serves your hosted picker site

If your Google OAuth consent screen is still in `Testing` for an external app:

- only explicitly added test users can authorize it
- refresh tokens can expire after 7 days, so long-lived auth behavior is not representative of a published app

The extension needs the desktop client ID and secret.

The hosted site needs:

- web client ID
- browser API key
- Google Cloud project number

## Hosted picker site

The hosted site lives under [../site/public](../site/public).

Hosted picker usage is explicit. Set `GDRIVESYNC_HOSTED_BASE_URL` or `gdocSync.development.hostedBaseUrl` when you want picker-based selection or hosted link-share recovery.

Keep [../site/public/site-config.js](../site/public/site-config.js) as a placeholder in git. Inject real production values during deployment.

Required routes:

- `/`
- `/privacy`
- `/picker`

No Worker is required for the current static-site deployment.

## Cloudflare Pages deployment

Deploy [../site/public](../site/public) as a static site on Cloudflare Pages.

The deploy workflow is in [../.github/workflows/deploy-pages.yml](../.github/workflows/deploy-pages.yml).

Expected GitHub secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `GDRIVESYNC_PICKER_API_KEY`

The workflow writes `site/public/site-config.js` during deploy and then runs `wrangler pages deploy`.

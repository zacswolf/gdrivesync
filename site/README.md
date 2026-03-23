# Hosted site

This folder contains the static site assets for Cloudflare Pages.

Deploy [public](/Users/zacschulwolf/Programming/gdocs_sync_vscode_extension/site/public) to `gdrivesync.zacswolf.com`.

Before deploy:

1. Replace the placeholder values in [site-config.js](/Users/zacschulwolf/Programming/gdocs_sync_vscode_extension/site/public/site-config.js)
2. Confirm the Google web OAuth client includes the Cloudflare Pages production origin
3. Confirm the consent screen homepage and privacy links point at the deployed site

The OAuth bridge page forwards Google redirect parameters from the hosted domain back to the extension’s localhost listener. The Picker page signs in with the web client, opens Google Picker, and returns the selected doc metadata to the extension.

For automatic deploys, connect the GitHub repo to Cloudflare Pages instead of using a direct-upload workflow. That gives you auto-deploys on `main` and keeps Pages aligned with the repository as the source of truth.

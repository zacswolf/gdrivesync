# Hosted site

This folder contains the static site assets for Cloudflare Pages.

Deploy [public](/Users/zacschulwolf/Programming/gdocs_sync_vscode_extension/site/public) to `gdrivesync.zacswolf.com`.

Before deploy:

1. Replace the placeholder values in [site-config.js](/Users/zacschulwolf/Programming/gdocs_sync_vscode_extension/site/public/site-config.js)
2. Confirm the Google web OAuth client includes the Cloudflare Pages production origin
3. Confirm the consent screen homepage and privacy links point at the deployed site

The Picker page signs in with the web client, opens Google Picker, and returns the selected doc metadata to the extension. Desktop OAuth happens directly against the extension's localhost callback and does not rely on the hosted site.

For automatic deploys, this repo uses a GitHub Actions workflow that runs `wrangler pages deploy` on pushes to `main`. That matches the rest of your Cloudflare Pages projects, which are already using Direct Upload.

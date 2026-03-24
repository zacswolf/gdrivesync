# Hosted site

This folder contains the static site assets for Cloudflare Pages.

Deploy [public](public) to your public GDriveSync site origin.

Before deploy:

1. Leave [site-config.js](public/site-config.js) as a placeholder in git
2. Set the real `GDRIVESYNC_PICKER_API_KEY` GitHub secret used by the Pages deploy workflow
3. Confirm the Google web OAuth client includes the Cloudflare Pages production origin
4. Confirm the consent screen homepage and privacy links point at the deployed site

The Picker page signs in with the web client, opens Google Picker, and returns canonical selected file metadata to the extension. Desktop OAuth happens directly against the extension's localhost callback and does not rely on the hosted site. Image enrichment is also unrelated to the hosted site: local OCR stays on the user's machine, and optional OpenAI or Anthropic calls go directly from the extension or CLI to those providers.

For automatic deploys, this repo uses a GitHub Actions workflow that runs `wrangler pages deploy` on pushes to `main`. That matches the rest of your Cloudflare Pages projects, which are already using Direct Upload.

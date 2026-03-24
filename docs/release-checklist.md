# Release Checklist

This checklist is for generic, repeatable release work that belongs in the repo.

Keep personal production details such as exact domains, Google Cloud project IDs, publisher credentials, and secret-management notes in a private gitignored file such as `docs/private/maintainer-release-notes.md`.

## Before tagging a release

- make sure the working tree is clean
- run the full verification pass:
  - `npm run compile`
  - `npm run test:unit`
  - `npm run test:cli`
  - `npm test`
- run a manual smoke test from a fresh machine profile or isolated local state
- confirm README, privacy policy, and marketplace/package metadata still match the current product

## Google Cloud and hosted site

- confirm the homepage and privacy-policy URLs are correct on the OAuth consent screen
- confirm the hosted picker domain is listed as an authorized domain
- confirm the hosted picker browser API key is restricted to the correct HTTP referrers
- if the app is still `Testing` and you are preparing for public use:
  - move the OAuth consent screen to `In production`
  - verify the right scopes, branding, and support contact are set
  - verify non-test users can authorize successfully
- do not publish publicly while the OAuth app is still limited to test users
- verify the published desktop OAuth client and consent screen branding match the release you are shipping

## Package and versioning

- bump the project version in `package.json` and `package-lock.json`
- update `CHANGELOG.md`
- keep `.gdrivesync.json` schema versioning separate from package semver
- only change manifest schema when the persisted manifest format actually changes
- review the current `xlsx` upstream advisory status, decide whether you still accept that upstream risk for this release, and keep the public docs accurate if it remains unresolved

## Publish targets

- publish the VS Code extension
- publish to Open VSX
- publish the CLI package to npm
- update any Homebrew tap or formula if you are distributing one

## Post-publish smoke test

- install the published extension in a clean VS Code profile
- install the published CLI from npm in a clean shell environment
- verify Google sign-in works
- verify linking and syncing a Docs file, a Slides file, and a Sheets file
- verify local image enrichment still works
- verify cloud image enrichment still works with newly configured provider keys

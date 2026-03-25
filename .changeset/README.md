# Changesets

GDriveSync uses Changesets to control extension and CLI releases from a single version stream.

Rules of thumb:

- Add a changeset when a PR should affect the next published extension or CLI release.
- Do not add a changeset for site-only, docs-only, or internal maintenance changes that should not create a product release.
- Merge to `main` normally. Changesets will open or update a release PR with the version bump and changelog.
- Merging the release PR is what triggers automated publishing to npm, the VS Code Marketplace, and Open VSX.

Useful commands:

- `npm run changeset`
- `npm run changeset:status`
- `npm run changeset:version`

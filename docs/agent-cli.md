# GDriveSync CLI for Agents

GDriveSync is most useful to agents when it is treated like a stateful bridge between Google Drive and a normal local workspace.

## Recommended usage patterns

- Use `gdrivesync inspect ... --json` before deciding whether a file should become Markdown, Marp Markdown, or CSV.
- Use `gdrivesync export ...` when the agent only needs a transient local read.
- Use `gdrivesync link ...` when the agent wants durable workspace state that can be refreshed later.
- Use `gdrivesync auth list --json` and `gdrivesync auth use <account> --json` when the agent needs explicit account control.
- Use `--account <email-or-id>` on `inspect`, `export`, `link`, or `sync` when deterministic account selection matters more than the default probing behavior.
- Use `--image-enrichment local` on `export`, `link`, or `sync` when the agent wants OCR-derived image alt text and compact image metadata comments in Markdown or Marp outputs.
- Use `gdrivesync status --all --json --cwd <workspace>` to discover linked files before a batch run.
- Use `gdrivesync sync --all --json --cwd <workspace>` for batch refreshes.
- Use `gdrivesync doctor --json --cwd <workspace>` before large automated runs if the agent needs to validate auth and manifest health.
- Always pass `--cwd` explicitly in automation instead of relying on the current shell directory.
- Prefer `--json` whenever the result will be parsed or routed to other tools.

## Exit code expectations

- `0`: the requested operation completed successfully, including no-op syncs that were already up to date
- `1`: the operation failed, or a sync was cancelled because local changes would have been overwritten

## Output expectations

- Normal human output is concise text intended for terminals.
- `--json` returns a stable envelope with:
  - `ok`
  - `contractVersion`
  - `command`
  - `data` on success or `error` on failure
- In `--json` mode, top-level command failures are also emitted as structured JSON with machine-readable error codes.

## Suggested agent workflows

Inspect a source before choosing a target:

```bash
gdrivesync inspect "https://docs.google.com/spreadsheets/d/<file-id>/edit" --json
```

Create a persistent local link:

```bash
gdrivesync link "https://docs.google.com/document/d/<file-id>/edit" "./notes/spec.md" --cwd "./workspace" --json
```

Choose the default connected Google account:

```bash
gdrivesync auth use "me@example.com" --json
```

Refresh all linked files in a workspace:

```bash
gdrivesync sync --all --cwd "./workspace" --json
```

Force one specific connected account for a single operation:

```bash
gdrivesync export "https://docs.google.com/document/d/<file-id>/edit" --account "work@example.com" --json
```

Validate workspace and auth health:

```bash
gdrivesync doctor --cwd "./workspace" --json
```

Export a single file directly to stdout:

```bash
gdrivesync export "https://docs.google.com/document/d/<file-id>/edit"
```

Export a Google Slides deck to Marp-flavored Markdown:

```bash
gdrivesync export "https://docs.google.com/presentation/d/<file-id>/edit" "./deck.md" --json
```

Export a deck with local OCR-based image enrichment:

```bash
gdrivesync export "https://docs.google.com/presentation/d/<file-id>/edit" "./deck.md" --image-enrichment local --json
```

## Practical guidance

- Expect Markdown outputs for Docs and DOCX.
- Native Google Docs use a DOCX export path under the hood so extracted images stay much more usable than Google’s native Markdown export.
- Expect Marp-flavored Markdown outputs for Google Slides and PowerPoint.
- Expect CSV or folder-of-CSV outputs for Sheets and XLSX.
- Local image enrichment is opt-in and local-only. It uses Apple Vision on macOS when possible, falls back to Tesseract when installed, and otherwise leaves the markdown unchanged.
- When enabled in `alt-plus-comment` mode, OCR metadata is stored inline as compact `<!-- gdrivesync:image-meta ... -->` comments right after rewritten image lines.
- Treat Google Drive as the source of truth. This project is one-way by design.
- Expect linked files to stay pinned to their bound Google account unless that account becomes unusable, in which case GDriveSync may recover via another connected account and report the rebind.
- If an agent wants to preserve local edits, it should inspect sync results and respect cancelled outcomes unless it intentionally reruns with `--force`.
- If the CLI reports `MANIFEST_CORRUPT` or `AUTH_SESSION_CORRUPT`, the supported recovery path is `gdrivesync doctor --repair`.

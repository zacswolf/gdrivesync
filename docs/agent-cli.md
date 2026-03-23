# GDriveSync CLI for Agents

GDriveSync is most useful to agents when it is treated like a stateful bridge between Google Drive and a normal local workspace.

## Recommended usage patterns

- Use `gdrivesync inspect ... --json` before deciding whether a file should become Markdown, Marp Markdown, or CSV.
- Use `gdrivesync export ...` when the agent only needs a transient local read.
- Use `gdrivesync link ...` when the agent wants durable workspace state that can be refreshed later.
- Use `gdrivesync status --all --json --cwd <workspace>` to discover linked files before a batch run.
- Use `gdrivesync sync --all --json --cwd <workspace>` for batch refreshes.
- Always pass `--cwd` explicitly in automation instead of relying on the current shell directory.
- Prefer `--json` whenever the result will be parsed or routed to other tools.

## Exit code expectations

- `0`: the requested operation completed successfully, including no-op syncs that were already up to date
- `1`: the operation failed, or a sync was cancelled because local changes would have been overwritten

## Output expectations

- Normal human output is concise text intended for terminals.
- `--json` returns structured output for machine consumers.
- In `--json` mode, top-level command failures are also emitted as JSON.

## Suggested agent workflows

Inspect a source before choosing a target:

```bash
gdrivesync inspect "https://docs.google.com/spreadsheets/d/<file-id>/edit" --json
```

Create a persistent local link:

```bash
gdrivesync link "https://docs.google.com/document/d/<file-id>/edit" "./notes/spec.md" --cwd "./workspace" --json
```

Refresh all linked files in a workspace:

```bash
gdrivesync sync --all --cwd "./workspace" --json
```

Export a single file directly to stdout:

```bash
gdrivesync export "https://docs.google.com/document/d/<file-id>/edit"
```

Export a Google Slides deck to Marp-flavored Markdown:

```bash
gdrivesync export "https://docs.google.com/presentation/d/<file-id>/edit" "./deck.md" --json
```

## Practical guidance

- Expect Markdown outputs for Docs and DOCX.
- Expect Marp-flavored Markdown outputs for Google Slides and PowerPoint.
- Expect CSV or folder-of-CSV outputs for Sheets and XLSX.
- Treat Google Drive as the source of truth. This project is one-way by design.
- If an agent wants to preserve local edits, it should inspect sync results and respect cancelled outcomes unless it intentionally reruns with `--force`.

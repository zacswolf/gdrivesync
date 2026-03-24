export type CorruptStateKind = "manifest" | "oauth-session" | "cli-config";

function defaultCorruptionMessage(kind: CorruptStateKind, stateLocation: string): string {
  if (kind === "manifest") {
    return `The GDriveSync manifest at ${stateLocation} is corrupted. Run gdrivesync doctor --repair to back it up and restore a working manifest.`;
  }

  if (kind === "cli-config") {
    return `The GDriveSync CLI config at ${stateLocation} is corrupted. Run gdrivesync doctor --repair to back it up and restore a working config.`;
  }

  return `The GDriveSync OAuth session at ${stateLocation} is corrupted. Run gdrivesync doctor --repair or sign in again.`;
}

export class CorruptStateError extends Error {
  readonly name = "CorruptStateError";

  constructor(
    readonly kind: CorruptStateKind,
    readonly stateLocation: string,
    message?: string,
    readonly details?: string
  ) {
    super(message || defaultCorruptionMessage(kind, stateLocation));
  }
}

export class ManifestBusyError extends Error {
  readonly name = "ManifestBusyError";

  constructor(readonly manifestPath: string) {
    super(`The GDriveSync manifest at ${manifestPath} is busy because another sync may already be updating it. Try again in a moment.`);
  }
}

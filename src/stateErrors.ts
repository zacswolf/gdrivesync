export type CorruptStateKind = "manifest" | "oauth-session";

function defaultCorruptionMessage(kind: CorruptStateKind, stateLocation: string): string {
  if (kind === "manifest") {
    return `The GDriveSync manifest at ${stateLocation} is corrupted. Run gdrivesync doctor --repair to back it up and restore a working manifest.`;
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

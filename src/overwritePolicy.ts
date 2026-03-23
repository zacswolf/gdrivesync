export interface LocalFileState {
  fileExists: boolean;
  isDirty: boolean;
  currentHash?: string;
}

export function needsOverwriteConfirmation(state: LocalFileState, lastLocalHash?: string): boolean {
  if (state.isDirty) {
    return true;
  }

  if (!state.fileExists) {
    return false;
  }

  if (!lastLocalHash) {
    return Boolean(state.currentHash);
  }

  return state.currentHash !== undefined && state.currentHash !== lastLocalHash;
}

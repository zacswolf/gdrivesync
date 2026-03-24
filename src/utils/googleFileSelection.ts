import { PickerGrantRequiredError } from "../driveClient";
import { SyncProfile, resolveSyncProfileForMimeType } from "../syncProfiles";
import { ParsedDocInput, PickerSelection, ResolvedGoogleFile } from "../types";
import { extractGoogleResourceKey } from "./docUrl";

export function normalizeResolvedGoogleFileSelection(
  resolvedFile: ResolvedGoogleFile,
  allowedProfiles: SyncProfile[],
  targetTypeDescription: string
): PickerSelection {
  const resolvedProfile = resolveSyncProfileForMimeType(resolvedFile.sourceMimeType);
  if (!resolvedProfile || !allowedProfiles.some((profile) => profile.id === resolvedProfile.id)) {
    throw new Error(`This Google file cannot sync to the selected ${targetTypeDescription} target.`);
  }

  return {
    profileId: resolvedProfile.id,
    fileId: resolvedFile.fileId,
    title: resolvedFile.title,
    sourceUrl: resolvedFile.sourceUrl || resolvedProfile.buildSourceUrl(resolvedFile.fileId),
    sourceMimeType: resolvedFile.sourceMimeType,
    resourceKey: resolvedFile.resourceKey || extractGoogleResourceKey(resolvedFile.sourceUrl)
  };
}

export function shouldRecoverAccessWithPicker(parsedInput: ParsedDocInput, error: unknown): boolean {
  if (!(error instanceof PickerGrantRequiredError)) {
    return false;
  }

  return !(parsedInput.resourceKey || extractGoogleResourceKey(parsedInput.sourceUrl));
}

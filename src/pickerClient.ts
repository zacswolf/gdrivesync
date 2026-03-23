import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

import { GoogleReleaseConfig, ParsedDocInput, PickerRequestPayload, PickerSelection } from "./types";
import { SyncProfile } from "./syncProfiles";
import { decodeBase64UrlJson, encodeBase64UrlJson } from "./utils/base64url";
import { createLocalCallbackServer } from "./utils/localCallbackServer";

export class PickerClient {
  constructor(private readonly configProvider: () => GoogleReleaseConfig) {}

  async pickDocument(profile: SyncProfile, initialFile?: ParsedDocInput): Promise<PickerSelection | undefined> {
    const callbackServer = await createLocalCallbackServer(
      "/picker/callback",
      `${profile.sourceTypeLabel} selected`,
      `Your ${profile.sourceTypeLabel} selection has been sent back to VS Code.`
    );
    const request = encodeBase64UrlJson({
      nonce: randomUUID(),
      localRedirect: callbackServer.localRedirect,
      profileId: profile.id,
      sourceMimeType: profile.sourceMimeType,
      sourceTypeLabel: profile.sourceTypeLabel,
      pickerViewId: profile.pickerViewId,
      pickerMimeTypes: profile.pickerMimeTypes,
      hintFileId: initialFile?.fileId,
      resourceKey: initialFile?.resourceKey
    });
    const pickerUrl = new URL(this.configProvider().pickerUrl);
    pickerUrl.hash = new URLSearchParams({ request }).toString();
    const opened = await vscode.env.openExternal(vscode.Uri.parse(pickerUrl.toString()));
    if (!opened) {
      await callbackServer.dispose();
      throw new Error("VS Code could not open the hosted Google Picker page.");
    }

    try {
      const callbackParams = await callbackServer.waitForCallback();
      const returnedState = callbackParams.get("state");
      if (!returnedState) {
        throw new Error("Google Picker returned without the request state.");
      }

      const expectedRequest = decodeBase64UrlJson<PickerRequestPayload>(request);
      const actualRequest = decodeBase64UrlJson<PickerRequestPayload>(returnedState);
      if (expectedRequest.nonce !== actualRequest.nonce) {
        throw new Error("Google Picker state verification failed.");
      }

      if (callbackParams.get("cancelled") === "1") {
        return undefined;
      }

      const error = callbackParams.get("error");
      if (error) {
        throw new Error(`Google Picker failed: ${error}`);
      }

      const fileId = callbackParams.get("fileId");
      const title = callbackParams.get("title");
      if (!fileId || !title) {
        throw new Error("Google Picker returned without a file selection.");
      }

      return {
        profileId: profile.id,
        fileId,
        title,
        sourceMimeType: callbackParams.get("sourceMimeType") || profile.sourceMimeType,
        resourceKey: callbackParams.get("resourceKey") || undefined,
        sourceUrl: callbackParams.get("sourceUrl") || profile.buildSourceUrl(fileId)
      };
    } finally {
      await callbackServer.dispose();
    }
  }
}

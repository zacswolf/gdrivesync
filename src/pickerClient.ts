import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

import { GoogleReleaseConfig, ParsedDocInput, PickerRequestPayload, ResolvedGoogleFile } from "./types";
import { decodeBase64UrlJson, encodeBase64UrlJson } from "./utils/base64url";
import { extractGoogleResourceKey } from "./utils/docUrl";
import { createLocalCallbackServer } from "./utils/localCallbackServer";

interface PickerRequestOptions {
  sourceTypeLabel: string;
  pickerViewId: string;
  pickerMimeTypes: string;
  loginHint?: string;
}

export class PickerClient {
  constructor(private readonly configProvider: () => GoogleReleaseConfig) {}

  async pickDocument(requestOptions: PickerRequestOptions, initialFile?: ParsedDocInput): Promise<ResolvedGoogleFile | undefined> {
    const hostedBaseUrl = this.configProvider().hostedBaseUrl;
    if (!hostedBaseUrl) {
      throw new Error(
        "Hosted Google Picker is not configured. Set GDRIVESYNC_HOSTED_BASE_URL or gdocSync.development.hostedBaseUrl to use picker-based selection."
      );
    }

    const callbackServer = await createLocalCallbackServer(
      "/picker/callback",
      `${requestOptions.sourceTypeLabel} selected`,
      `Your ${requestOptions.sourceTypeLabel} selection has been sent back to VS Code.`
    );
    const request = encodeBase64UrlJson({
      nonce: randomUUID(),
      localRedirect: callbackServer.localRedirect,
      sourceTypeLabel: requestOptions.sourceTypeLabel,
      pickerViewId: requestOptions.pickerViewId,
      pickerMimeTypes: requestOptions.pickerMimeTypes,
      supportedMimeTypes: requestOptions.pickerMimeTypes.split(",").map((value) => value.trim()).filter(Boolean),
      hintFileId: initialFile?.fileId,
      resourceKey: initialFile?.resourceKey,
      loginHint: requestOptions.loginHint || this.configProvider().loginHint
    });
    const pickerUrl = new URL(`${hostedBaseUrl}/picker`);
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
      if (!fileId) {
        throw new Error("Google Picker returned without a file selection.");
      }

      return {
        fileId,
        title: callbackParams.get("title") || requestOptions.sourceTypeLabel,
        sourceUrl: callbackParams.get("sourceUrl") || "",
        sourceMimeType: callbackParams.get("sourceMimeType") || "",
        resourceKey:
          callbackParams.get("resourceKey") ||
          extractGoogleResourceKey(callbackParams.get("sourceUrl") || undefined) ||
          undefined
      };
    } finally {
      await callbackServer.dispose();
    }
  }
}

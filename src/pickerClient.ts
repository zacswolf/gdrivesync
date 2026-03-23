import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

import { GoogleReleaseConfig, ParsedDocInput, PickerRequestPayload, PickerSelection } from "./types";
import { decodeBase64UrlJson, encodeBase64UrlJson } from "./utils/base64url";
import { buildGoogleDocUrl } from "./utils/docUrl";
import { createLocalCallbackServer } from "./utils/localCallbackServer";

export class PickerClient {
  constructor(private readonly configProvider: () => GoogleReleaseConfig) {}

  async pickDocument(initialDoc?: ParsedDocInput): Promise<PickerSelection | undefined> {
    const callbackServer = await createLocalCallbackServer(
      "/picker/callback",
      "Google Doc selected",
      "Your Google Doc selection has been sent back to VS Code."
    );
    const request = encodeBase64UrlJson({
      nonce: randomUUID(),
      localRedirect: callbackServer.localRedirect,
      hintDocId: initialDoc?.docId,
      resourceKey: initialDoc?.resourceKey
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

      const docId = callbackParams.get("docId");
      const title = callbackParams.get("title");
      if (!docId || !title) {
        throw new Error("Google Picker returned without a Doc selection.");
      }

      return {
        docId,
        title,
        resourceKey: callbackParams.get("resourceKey") || undefined,
        sourceUrl: callbackParams.get("sourceUrl") || buildGoogleDocUrl(docId)
      };
    } finally {
      await callbackServer.dispose();
    }
  }
}

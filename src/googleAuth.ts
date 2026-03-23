import { createHash, randomUUID } from "node:crypto";
import { URLSearchParams } from "node:url";

import * as vscode from "vscode";

import { GoogleReleaseConfig, OAuthStatePayload, StoredOAuthSession, TokenStore } from "./types";
import { decodeBase64UrlJson, encodeBase64UrlJson } from "./utils/base64url";
import { createLocalCallbackServer } from "./utils/localCallbackServer";

type FetchLike = typeof fetch;

function buildCodeVerifier(): string {
  return Buffer.from(randomUUID().repeat(2), "utf8").toString("base64url");
}

function buildCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
}

function willExpireSoon(session: StoredOAuthSession): boolean {
  return session.expiresAt <= Date.now() + 60_000;
}

function buildAuthorizationUrl(config: GoogleReleaseConfig, codeChallenge: string, state: string, redirectUri: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.desktopClientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

export class GoogleAuthManager {
  constructor(
    private readonly tokenStore: TokenStore,
    private readonly configProvider: () => GoogleReleaseConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async signIn(): Promise<void> {
    const config = this.configProvider();
    const callbackServer = await createLocalCallbackServer(
      "/oauth/callback",
      "GDriveSync connected",
      "Your Google account is now connected to GDriveSync."
    );
    const nonce = randomUUID();
    const state = encodeBase64UrlJson({ nonce });
    const codeVerifier = buildCodeVerifier();
    const codeChallenge = buildCodeChallenge(codeVerifier);
    const authorizationUrl = buildAuthorizationUrl(config, codeChallenge, state, callbackServer.localRedirect);
    const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizationUrl));
    if (!opened) {
      await callbackServer.dispose();
      throw new Error("VS Code could not open your browser for Google sign-in.");
    }

    try {
      const callbackParams = await callbackServer.waitForCallback();
      const returnedState = callbackParams.get("state");
      if (!returnedState) {
        throw new Error("Google sign-in returned without a state value.");
      }

      const decodedState = decodeBase64UrlJson<OAuthStatePayload>(returnedState);
      if (decodedState.nonce !== nonce) {
        throw new Error("Google sign-in state verification failed.");
      }

      const authError = callbackParams.get("error");
      if (authError) {
        throw new Error(`Google sign-in failed: ${authError}`);
      }

      const code = callbackParams.get("code");
      if (!code) {
        throw new Error("Google sign-in returned without an authorization code.");
      }

      const existingSession = await this.tokenStore.get();
      const nextSession = await this.exchangeAuthorizationCode(
        code,
        codeVerifier,
        callbackServer.localRedirect,
        config,
        existingSession?.refreshToken
      );
      await this.tokenStore.set(nextSession);
    } finally {
      await callbackServer.dispose();
    }
  }

  async ensureSignedIn(): Promise<void> {
    const session = await this.tokenStore.get();
    if (session) {
      return;
    }

    await this.signIn();
  }

  async getAccessToken(): Promise<string> {
    const config = this.configProvider();
    const session = await this.tokenStore.get();
    if (!session) {
      throw new Error("You need to sign in to Google before syncing.");
    }

    if (!willExpireSoon(session)) {
      return session.accessToken;
    }

    if (!session.refreshToken) {
      throw new Error("The saved Google session cannot be refreshed. Please sign in again.");
    }

    const refreshedSession = await this.refreshAccessToken(config, session);
    await this.tokenStore.set(refreshedSession);
    return refreshedSession.accessToken;
  }

  async signOut(): Promise<void> {
    const session = await this.tokenStore.get();
    if (session?.refreshToken || session?.accessToken) {
      const token = session.refreshToken || session.accessToken;
      const revokeUrl = new URL("https://oauth2.googleapis.com/revoke");
      const revokeBody = new URLSearchParams({ token });
      await this.fetchImpl(revokeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded"
        },
        body: revokeBody.toString()
      }).catch(() => undefined);
    }

    await this.tokenStore.delete();
  }

  private async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    config: GoogleReleaseConfig,
    fallbackRefreshToken?: string
  ): Promise<StoredOAuthSession> {
    const body = new URLSearchParams({
      client_id: config.desktopClientId,
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    });

    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Google token exchange failed (${response.status}): ${details}`);
    }

    const payload = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      scope: string;
      token_type: string;
    };

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || fallbackRefreshToken,
      expiresAt: Date.now() + payload.expires_in * 1000,
      scope: payload.scope,
      tokenType: payload.token_type
    };
  }

  private async refreshAccessToken(config: GoogleReleaseConfig, session: StoredOAuthSession): Promise<StoredOAuthSession> {
    const body = new URLSearchParams({
      client_id: config.desktopClientId,
      grant_type: "refresh_token",
      refresh_token: session.refreshToken || ""
    });

    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Google token refresh failed (${response.status}): ${details}`);
    }

    const payload = (await response.json()) as {
      access_token: string;
      expires_in: number;
      scope: string;
      token_type: string;
    };

    return {
      accessToken: payload.access_token,
      refreshToken: session.refreshToken,
      expiresAt: Date.now() + payload.expires_in * 1000,
      scope: payload.scope,
      tokenType: payload.token_type
    };
  }
}

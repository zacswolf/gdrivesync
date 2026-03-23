import { createHash, randomUUID } from "node:crypto";
import { URLSearchParams } from "node:url";

import * as vscode from "vscode";

import { GoogleReleaseConfig, OAuthStatePayload, StoredOAuthSession, TokenStore } from "./types";
import { decodeBase64UrlJson, encodeBase64UrlJson } from "./utils/base64url";
import { createLocalCallbackServer } from "./utils/localCallbackServer";
import { hasRequiredScopes } from "./utils/oauthScopes";

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

function formatTokenError(status: number, details: string, missingClientSecretHint: boolean): string {
  if (missingClientSecretHint && details.includes('"client_secret is missing"')) {
    return "Google token exchange failed: set gdocSync.development.desktopClientSecret in your local user settings and try sign-in again.";
  }

  return `Google token exchange failed (${status}): ${details}`;
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

      await this.completeAuthorizationCodeGrant(code, callbackServer.localRedirect, codeVerifier);
    } finally {
      await callbackServer.dispose();
    }
  }

  async completeAuthorizationCodeGrant(code: string, redirectUri: string, codeVerifier?: string): Promise<void> {
    const config = this.configProvider();
    const existingSession = await this.tokenStore.get();
    const nextSession = await this.exchangeAuthorizationCode(
      code,
      codeVerifier,
      redirectUri,
      config,
      existingSession?.refreshToken
    );
    await this.tokenStore.set(nextSession);
  }

  async ensureSignedIn(): Promise<void> {
    const config = this.configProvider();
    const session = await this.tokenStore.get();
    if (session && hasRequiredScopes(session.scope, config.scope)) {
      return;
    }

    if (session) {
      await this.tokenStore.delete();
    }
    await this.signIn();
  }

  async getAccessToken(): Promise<string> {
    const config = this.configProvider();
    const session = await this.tokenStore.get();
    if (!session) {
      throw new Error("You need to sign in to Google before syncing.");
    }

    if (!hasRequiredScopes(session.scope, config.scope)) {
      await this.tokenStore.delete();
      throw new Error("Your saved Google session is missing the required Drive read-only scope. Please sign in again.");
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
    codeVerifier: string | undefined,
    redirectUri: string,
    config: GoogleReleaseConfig,
    fallbackRefreshToken?: string
  ): Promise<StoredOAuthSession> {
    const body = new URLSearchParams({
      client_id: config.desktopClientId,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    });
    if (codeVerifier) {
      body.set("code_verifier", codeVerifier);
    }
    if (config.desktopClientSecret) {
      body.set("client_secret", config.desktopClientSecret);
    }

    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(formatTokenError(response.status, details, !config.desktopClientSecret));
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
      scope: payload.scope || config.scope,
      tokenType: payload.token_type
    };
  }

  private async refreshAccessToken(config: GoogleReleaseConfig, session: StoredOAuthSession): Promise<StoredOAuthSession> {
    const body = new URLSearchParams({
      client_id: config.desktopClientId,
      grant_type: "refresh_token",
      refresh_token: session.refreshToken || ""
    });
    if (config.desktopClientSecret) {
      body.set("client_secret", config.desktopClientSecret);
    }

    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(formatTokenError(response.status, details, !config.desktopClientSecret));
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
      scope: payload.scope || session.scope,
      tokenType: payload.token_type
    };
  }
}

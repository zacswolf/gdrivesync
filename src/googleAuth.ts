import { createHash, randomUUID } from "node:crypto";
import { URLSearchParams } from "node:url";

import {
  ConnectedGoogleAccount,
  DriveUserInfo,
  GoogleReleaseConfig,
  OAuthStatePayload,
  OAuthStateStore,
  StoredOAuthSession,
  StoredOAuthState
} from "./types";
import { CorruptStateError } from "./stateErrors";
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

function formatTokenError(status: number, details: string, missingClientSecretHint: boolean): string {
  if (missingClientSecretHint && details.includes('"client_secret is missing"')) {
    return "Google token exchange failed: set gdocSync.development.desktopClientSecret in your local user settings and try sign-in again.";
  }

  return `Google token exchange failed (${status}): ${details}`;
}

function normalizeState(state: StoredOAuthState): StoredOAuthState {
  const accounts = Object.fromEntries(
    Object.entries(state.accounts).sort(([left], [right]) => left.localeCompare(right))
  );
  const defaultAccountId = state.defaultAccountId && accounts[state.defaultAccountId]
    ? state.defaultAccountId
    : Object.keys(accounts)[0];

  return {
    version: 1,
    defaultAccountId,
    accounts
  };
}

function buildAuthorizationUrl(
  config: GoogleReleaseConfig,
  codeChallenge: string,
  state: string,
  redirectUri: string,
  options: { loginHint?: string; forceAccountSelection?: boolean } = {}
): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.desktopClientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (options.forceAccountSelection && !options.loginHint) {
    url.searchParams.set("prompt", "select_account");
  }
  if (options.loginHint) {
    url.searchParams.set("login_hint", options.loginHint);
  } else if (config.loginHint) {
    url.searchParams.set("login_hint", config.loginHint);
  }
  return url.toString();
}

async function revokeSession(fetchImpl: FetchLike, session: StoredOAuthSession | undefined): Promise<void> {
  if (!session?.refreshToken && !session?.accessToken) {
    return;
  }

  const token = session.refreshToken || session.accessToken;
  const revokeUrl = new URL("https://oauth2.googleapis.com/revoke");
  const revokeBody = new URLSearchParams({ token });
  await fetchImpl(revokeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: revokeBody.toString()
  }).catch(() => undefined);
}

export class GoogleAuthManager {
  constructor(
    private readonly stateStore: OAuthStateStore,
    private readonly configProvider: () => GoogleReleaseConfig,
    private readonly openExternalUrl: (url: string) => Promise<boolean>,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async connectAccount(options: { loginHint?: string } = {}): Promise<ConnectedGoogleAccount> {
    const config = this.configProvider();
    const existingState = await this.loadState();
    const callbackServer = await createLocalCallbackServer(
      "/oauth/callback",
      "GDriveSync connected",
      "Your Google account is now connected to GDriveSync."
    );
    const nonce = randomUUID();
    const state = encodeBase64UrlJson({ nonce });
    const codeVerifier = buildCodeVerifier();
    const codeChallenge = buildCodeChallenge(codeVerifier);
    const authorizationUrl = buildAuthorizationUrl(config, codeChallenge, state, callbackServer.localRedirect, {
      loginHint: options.loginHint,
      forceAccountSelection: Object.keys(existingState.accounts).length > 0
    });
    const opened = await this.openExternalUrl(authorizationUrl);
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

      const session = await this.exchangeAuthorizationCode(code, callbackServer.localRedirect, codeVerifier, config);
      const nextAccount = await this.buildConnectedAccount(session);
      const nextState = normalizeState({
        version: 1,
        defaultAccountId: existingState.defaultAccountId || nextAccount.accountId,
        accounts: {
          ...existingState.accounts,
          [nextAccount.accountId]: nextAccount
        }
      });
      await this.stateStore.save(nextState);
      return nextState.accounts[nextAccount.accountId];
    } finally {
      await callbackServer.dispose();
    }
  }

  async ensureConnected(): Promise<void> {
    const state = await this.loadState();
    if (Object.keys(state.accounts).length > 0) {
      return;
    }
    await this.connectAccount();
  }

  async listAccounts(): Promise<ConnectedGoogleAccount[]> {
    const state = await this.loadState();
    return Object.values(state.accounts);
  }

  async getDefaultAccount(): Promise<ConnectedGoogleAccount | undefined> {
    const state = await this.loadState();
    return state.defaultAccountId ? state.accounts[state.defaultAccountId] : undefined;
  }

  async setDefaultAccount(accountRef: string): Promise<ConnectedGoogleAccount> {
    const state = await this.loadState();
    const account = this.resolveAccountFromState(state, accountRef);
    const nextState = normalizeState({
      ...state,
      defaultAccountId: account.accountId
    });
    await this.stateStore.save(nextState);
    return nextState.accounts[account.accountId];
  }

  async disconnectAccount(accountRef: string): Promise<ConnectedGoogleAccount | undefined> {
    const state = await this.loadState();
    const account = this.tryResolveAccountFromState(state, accountRef);
    if (!account) {
      return undefined;
    }

    await revokeSession(this.fetchImpl, account.session);
    const nextAccounts = { ...state.accounts };
    delete nextAccounts[account.accountId];
    const nextState = normalizeState({
      version: 1,
      defaultAccountId: state.defaultAccountId === account.accountId ? undefined : state.defaultAccountId,
      accounts: nextAccounts
    });
    if (Object.keys(nextState.accounts).length === 0) {
      await this.stateStore.clear();
    } else {
      await this.stateStore.save(nextState);
    }
    return account;
  }

  async disconnectAll(): Promise<number> {
    const state = await this.loadState();
    const accounts = Object.values(state.accounts);
    for (const account of accounts) {
      await revokeSession(this.fetchImpl, account.session);
    }
    await this.stateStore.clear();
    return accounts.length;
  }

  async getAccessToken(accountId?: string): Promise<{ account: ConnectedGoogleAccount; accessToken: string }> {
    const config = this.configProvider();
    const state = await this.loadState();
    const account = accountId
      ? this.resolveAccountFromState(state, accountId)
      : state.defaultAccountId
        ? state.accounts[state.defaultAccountId]
        : undefined;

    if (!account) {
      throw new Error("You need to connect a Google account before syncing.");
    }

    if (!hasRequiredScopes(account.session.scope, config.scope)) {
      throw new Error(`The saved Google session for ${account.accountEmail || account.accountId} is missing the required Drive read-only scope. Connect that account again.`);
    }

    if (!willExpireSoon(account.session)) {
      return {
        account,
        accessToken: account.session.accessToken
      };
    }

    if (!account.session.refreshToken) {
      throw new Error(`The saved Google session for ${account.accountEmail || account.accountId} cannot be refreshed. Connect that account again.`);
    }

    const refreshedSession = await this.refreshAccessToken(config, account.session);
    const nextAccount: ConnectedGoogleAccount = {
      ...account,
      session: refreshedSession
    };
    const nextState = normalizeState({
      ...state,
      accounts: {
        ...state.accounts,
        [account.accountId]: nextAccount
      }
    });
    await this.stateStore.save(nextState);
    return {
      account: nextAccount,
      accessToken: refreshedSession.accessToken
    };
  }

  async getAccountsInPriorityOrder(preferredAccountId?: string): Promise<ConnectedGoogleAccount[]> {
    const state = await this.loadState();
    const accounts = Object.values(state.accounts);
    if (!preferredAccountId) {
      if (!state.defaultAccountId) {
        return accounts;
      }
      return accounts.sort((left, right) => {
        if (left.accountId === state.defaultAccountId) {
          return -1;
        }
        if (right.accountId === state.defaultAccountId) {
          return 1;
        }
        return left.accountId.localeCompare(right.accountId);
      });
    }

    return accounts.sort((left, right) => {
      if (left.accountId === preferredAccountId) {
        return -1;
      }
      if (right.accountId === preferredAccountId) {
        return 1;
      }
      return left.accountId.localeCompare(right.accountId);
    });
  }

  async resolveAccount(accountRef: string): Promise<ConnectedGoogleAccount> {
    const state = await this.loadState();
    return this.resolveAccountFromState(state, accountRef);
  }

  private async loadState(): Promise<StoredOAuthState> {
    try {
      const loaded = await this.stateStore.load();
      if (loaded) {
        return normalizeState(loaded);
      }
    } catch (error) {
      if (error instanceof CorruptStateError) {
        await this.stateStore.clear();
        return {
          version: 1,
          accounts: {}
        };
      }
      throw error;
    }

    return {
      version: 1,
      accounts: {}
    };
  }

  private tryResolveAccountFromState(state: StoredOAuthState, accountRef: string): ConnectedGoogleAccount | undefined {
    if (state.accounts[accountRef]) {
      return state.accounts[accountRef];
    }

    const normalizedRef = accountRef.trim().toLowerCase();
    return Object.values(state.accounts).find((account) => account.accountEmail?.toLowerCase() === normalizedRef);
  }

  private resolveAccountFromState(state: StoredOAuthState, accountRef: string): ConnectedGoogleAccount {
    const account = this.tryResolveAccountFromState(state, accountRef);
    if (!account) {
      throw new Error(`No connected Google account matches ${accountRef}.`);
    }
    return account;
  }

  private async buildConnectedAccount(session: StoredOAuthSession): Promise<ConnectedGoogleAccount> {
    const currentUser = await this.fetchDriveUser(session.accessToken);
    if (!currentUser?.permissionId) {
      throw new Error("Google sign-in succeeded, but Drive did not return a stable account ID.");
    }

    return {
      accountId: currentUser.permissionId,
      accountEmail: currentUser.emailAddress,
      accountDisplayName: currentUser.displayName,
      session
    };
  }

  private async fetchDriveUser(accessToken: string): Promise<DriveUserInfo | undefined> {
    const url = new URL("https://www.googleapis.com/drive/v3/about");
    url.searchParams.set("fields", "user(displayName,emailAddress,permissionId)");

    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as { user?: DriveUserInfo };
    return payload.user;
  }

  private async exchangeAuthorizationCode(
    code: string,
    redirectUri: string,
    codeVerifier: string | undefined,
    config: GoogleReleaseConfig
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
      refreshToken: payload.refresh_token,
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

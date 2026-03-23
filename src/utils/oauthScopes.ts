function parseScopeList(rawValue: string | undefined): Set<string> {
  return new Set(
    (rawValue || "")
      .split(/\s+/)
      .map((scope) => scope.trim())
      .filter(Boolean)
  );
}

export function hasRequiredScopes(grantedScopes: string | undefined, requiredScopes: string | undefined): boolean {
  const required = parseScopeList(requiredScopes);
  if (required.size === 0) {
    return true;
  }

  const granted = parseScopeList(grantedScopes);
  for (const requiredScope of required) {
    if (!granted.has(requiredScope)) {
      return false;
    }
  }

  return true;
}

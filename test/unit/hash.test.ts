import { describe, expect, it } from "vitest";

import { sha256Text } from "../../src/utils/hash";

describe("sha256Text", () => {
  it("hashes deterministically", () => {
    expect(sha256Text("hello world")).toBe("sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });
});

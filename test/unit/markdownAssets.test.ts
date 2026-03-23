import { describe, expect, it } from "vitest";

import { containsEmbeddedImageData, extractMarkdownAssets } from "../../src/utils/markdownAssets";

describe("extractMarkdownAssets", () => {
  it("moves embedded reference and inline images into a sibling assets folder", () => {
    const result = extractMarkdownAssets(
      "/tmp/burnt-beans-bgd-idea-tech-explainer.md",
      [
        "**![][image1]**",
        "",
        "Inline image: ![Hero Shot](data:image/jpeg;base64,V29ybGQ=)",
        "",
        "[image1]: <data:image/png;base64,SGVsbG8=>"
      ].join("\n")
    );

    expect(result.markdown).toContain(
      "**![image1](./burnt-beans-bgd-idea-tech-explainer.assets/image1.png)**"
    );
    expect(result.markdown).toContain(
      "![Hero Shot](./burnt-beans-bgd-idea-tech-explainer.assets/hero-shot.jpg)"
    );
    expect(result.markdown).not.toContain("[image1]:");
    expect(result.generatedAssetPaths).toEqual([
      "burnt-beans-bgd-idea-tech-explainer.assets/image1.png",
      "burnt-beans-bgd-idea-tech-explainer.assets/hero-shot.jpg"
    ]);
    expect(Buffer.from(result.assets[0]?.bytes || []).toString("utf8")).toBe("Hello");
    expect(Buffer.from(result.assets[1]?.bytes || []).toString("utf8")).toBe("World");
  });

  it("detects embedded image data", () => {
    expect(containsEmbeddedImageData("![x](data:image/png;base64,SGVsbG8=)")).toBe(true);
    expect(containsEmbeddedImageData("![x](./image.png)")).toBe(false);
  });
});

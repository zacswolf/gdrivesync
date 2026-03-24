import { describe, expect, it } from "vitest";

import { convertSlidesApiPresentationToMarp } from "../../src/slidesApiPresentationConverter";

const PNG_PIXEL_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9r8AAAAASUVORK5CYII=";

describe("convertSlidesApiPresentationToMarp", () => {
  it("converts Google Slides API presentation data into Marp markdown with assets", async () => {
    const imageBytes = Buffer.from(PNG_PIXEL_BASE64, "base64");
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://images.example.com/slide-1.png") {
        return new Response(imageBytes, {
          status: 200,
          headers: {
            "content-type": "image/png"
          }
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await convertSlidesApiPresentationToMarp(
      "/tmp/growth-burst.md",
      {
        title: "Growth Burst",
        slides: [
          {
            objectId: "slide-1",
            pageElements: [
              {
                objectId: "shape-1",
                shape: {
                  placeholder: {
                    type: "TITLE"
                  },
                  text: {
                    textElements: [
                      {
                        paragraphMarker: {}
                      },
                      {
                        textRun: {
                          content: "Lesson 1\n"
                        }
                      }
                    ]
                  }
                }
              },
              {
                objectId: "shape-2",
                shape: {
                  placeholder: {
                    type: "BODY"
                  },
                  text: {
                    textElements: [
                      {
                        paragraphMarker: {
                          bullet: {
                            nestingLevel: 0
                          }
                        }
                      },
                      {
                        textRun: {
                          content: "First point\n"
                        }
                      },
                      {
                        paragraphMarker: {
                          bullet: {
                            nestingLevel: 1
                          }
                        }
                      },
                      {
                        textRun: {
                          content: "Nested point\n"
                        }
                      }
                    ]
                  }
                }
              },
              {
                objectId: "image-1",
                title: "Diagram",
                image: {
                  contentUrl: "https://images.example.com/slide-1.png"
                }
              }
            ]
          }
        ]
      },
      {
        assetMode: "external",
        title: "Growth Burst"
      },
      fetchImpl
    );

    expect(result.slideCount).toBe(1);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.relativePath).toMatch(/^growth-burst\.assets\/slide-1-diagram-[a-f0-9]{12}\.png$/);
    expect(result.markdown).toContain("marp: true");
    expect(result.markdown).toContain("Generated via Google Slides API fallback");
    expect(result.markdown).toContain("# Lesson 1");
    expect(result.markdown).toContain("- First point");
    expect(result.markdown).toContain("  - Nested point");
    expect(result.markdown).toContain(`![Diagram](./${result.assets[0]?.relativePath})`);
  });

  it("can inline Google Slides API images as data URIs", async () => {
    const imageBytes = Buffer.from(PNG_PIXEL_BASE64, "base64");
    const fetchImpl: typeof fetch = async () =>
      new Response(imageBytes, {
        status: 200,
        headers: {
          "content-type": "image/png"
        }
      });

    const result = await convertSlidesApiPresentationToMarp(
      "/tmp/growth-burst.md",
      {
        title: "Growth Burst",
        slides: [
          {
            objectId: "slide-1",
            pageElements: [
              {
                objectId: "image-1",
                title: "Diagram",
                image: {
                  contentUrl: "https://images.example.com/slide-1.png"
                }
              }
            ]
          }
        ]
      },
      {
        assetMode: "data-uri",
        title: "Growth Burst"
      },
      fetchImpl
    );

    expect(result.assets).toEqual([]);
    expect(result.generatedAssetPaths).toEqual([]);
    expect(result.markdown).toContain("data:image/png;base64,");
  });

  it("deduplicates repeated slide images across a deck", async () => {
    const imageBytes = Buffer.from(PNG_PIXEL_BASE64, "base64");
    let fetchCount = 0;
    const fetchImpl: typeof fetch = async (input) => {
      fetchCount += 1;
      const url = String(input);
      if (url !== "https://images.example.com/shared-logo.png") {
        throw new Error(`Unexpected URL: ${url}`);
      }

      return new Response(imageBytes, {
        status: 200,
        headers: {
          "content-type": "image/png"
        }
      });
    };

    const result = await convertSlidesApiPresentationToMarp(
      "/tmp/growth-burst.md",
      {
        title: "Growth Burst",
        slides: [
          {
            objectId: "slide-1",
            pageElements: [
              {
                objectId: "image-1",
                title: "Shared Logo",
                image: {
                  contentUrl: "https://images.example.com/shared-logo.png"
                }
              }
            ]
          },
          {
            objectId: "slide-2",
            pageElements: [
              {
                objectId: "image-2",
                title: "Shared Logo Again",
                image: {
                  contentUrl: "https://images.example.com/shared-logo.png"
                }
              }
            ]
          }
        ]
      },
      {
        assetMode: "external",
        title: "Growth Burst"
      },
      fetchImpl
    );

    expect(fetchCount).toBe(1);
    expect(result.assets).toHaveLength(1);
    expect(result.generatedAssetPaths).toHaveLength(1);
    expect(result.markdown).toContain("![Shared Logo](");
    expect(result.markdown).toContain("![Shared Logo Again](");
  });
});

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { convertPresentationToMarp } from "../../src/presentationConverter";

const PNG_PIXEL_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9r8AAAAASUVORK5CYII=";

async function buildSamplePresentation(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId1"/>
    <p:sldId id="257" r:id="rId2"/>
  </p:sldIdLst>
</p:presentation>`
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="slides/slide1.xml" />
  <Relationship Id="rId2" Target="slides/slide2.xml" />
</Relationships>`
  );
  zip.file(
    "ppt/slides/slide1.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody>
          <a:p><a:r><a:t>Quarterly Review</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
        <p:txBody>
          <a:p><a:r><a:t>Revenue up 20%</a:t></a:r></a:p>
          <a:p><a:pPr lvl="1"/><a:r><a:t>North America</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:pic>
        <p:nvPicPr>
          <p:cNvPr id="4" name="Revenue Chart" descr="Revenue Chart"/>
        </p:nvPicPr>
        <p:blipFill><a:blip r:embed="rIdImg1"/></p:blipFill>
      </p:pic>
    </p:spTree>
  </p:cSld>
</p:sld>`
  );
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdImg1" Target="../media/image1.png" />
</Relationships>`
  );
  zip.file(
    "ppt/slides/slide2.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody>
          <a:p><a:r><a:t>Next Steps</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:nvPr><p:ph type="subTitle"/></p:nvPr></p:nvSpPr>
        <p:txBody>
          <a:p><a:r><a:t>Ship Slides support</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`
  );
  zip.file(
    "ppt/slides/_rels/slide2.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`
  );
  zip.file("ppt/media/image1.png", Buffer.from(PNG_PIXEL_BASE64, "base64"));
  return zip.generateAsync({ type: "uint8array" });
}

describe("convertPresentationToMarp", () => {
  it("converts a PPTX into Marp markdown with external assets", async () => {
    const bytes = await buildSamplePresentation();
    const result = await convertPresentationToMarp("/tmp/quarterly-review.md", bytes, {
      assetMode: "external",
      title: "Quarterly Review Deck"
    });

    expect(result.slideCount).toBe(2);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.relativePath).toBe("quarterly-review.assets/slide-1-revenue-chart.png");
    expect(result.generatedAssetPaths).toEqual(["quarterly-review.assets/slide-1-revenue-chart.png"]);
    expect(result.markdown).toContain("marp: true");
    expect(result.markdown).toContain('title: "Quarterly Review Deck"');
    expect(result.markdown).toContain("# Quarterly Review");
    expect(result.markdown).toContain("- Revenue up 20%");
    expect(result.markdown).toContain("  - North America");
    expect(result.markdown).toContain("![Revenue Chart](./quarterly-review.assets/slide-1-revenue-chart.png)");
    expect(result.markdown).toContain("\n\n---\n\n# Next Steps");
    expect(result.markdown).toContain("Ship Slides support");
  });

  it("can inline presentation images as data URIs", async () => {
    const bytes = await buildSamplePresentation();
    const result = await convertPresentationToMarp("/tmp/quarterly-review.md", bytes, {
      assetMode: "data-uri",
      title: "Quarterly Review Deck"
    });

    expect(result.assets).toEqual([]);
    expect(result.generatedAssetPaths).toEqual([]);
    expect(result.markdown).toContain("data:image/png;base64,");
  });
});

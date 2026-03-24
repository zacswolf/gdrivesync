import { describe, expect, it } from "vitest";

import { parseAppleVisionOutput } from "../../src/appleVisionOcr";
import { parseTesseractTsv } from "../../src/tesseractOcr";

describe("parseAppleVisionOutput", () => {
  it("parses helper JSON output", () => {
    expect(
      parseAppleVisionOutput('[{"path":"/tmp/image.png","text":"Hello world"},{"path":"/tmp/bad.png","error":"failed"}]')
    ).toEqual([
      {
        path: "/tmp/image.png",
        text: "Hello world",
        error: undefined
      },
      {
        path: "/tmp/bad.png",
        text: undefined,
        error: "failed"
      }
    ]);
  });
});

describe("parseTesseractTsv", () => {
  it("filters low-confidence rows and rebuilds OCR text lines", () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "5\t1\t1\t1\t1\t1\t0\t0\t0\t0\t96\tCreative",
      "5\t1\t1\t1\t1\t2\t0\t0\t0\t0\t92\tstrategy",
      "5\t1\t1\t1\t2\t1\t0\t0\t0\t0\t30\tjunk",
      "5\t1\t1\t1\t3\t1\t0\t0\t0\t0\t88\tagency"
    ].join("\n");

    expect(parseTesseractTsv(tsv)).toBe("Creative strategy\nagency");
  });

  it("keeps lines from separate blocks distinct even when line numbers repeat", () => {
    const tsv = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "5\t1\t1\t1\t1\t1\t0\t0\t0\t0\t96\tLeft",
      "5\t1\t1\t1\t1\t2\t0\t0\t0\t0\t92\tpanel",
      "5\t1\t2\t1\t1\t1\t0\t0\t0\t0\t91\tRight",
      "5\t1\t2\t1\t1\t2\t0\t0\t0\t0\t90\tpanel"
    ].join("\n");

    expect(parseTesseractTsv(tsv)).toBe("Left panel\nRight panel");
  });
});

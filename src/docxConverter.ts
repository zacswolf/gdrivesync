import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

function createTurndownService(): TurndownService {
  const service = new TurndownService({
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    headingStyle: "atx",
    bulletListMarker: "-",
    linkStyle: "inlined"
  });
  service.use(gfm);
  return service;
}

export async function convertDocxToMarkdown(docxBytes: Uint8Array): Promise<string> {
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(docxBytes) },
    {
      convertImage: mammoth.images.imgElement((image) =>
        image.readAsBase64String().then((base64Value) => ({
          src: `data:${image.contentType};base64,${base64Value}`
        }))
      )
    }
  );

  const markdown = createTurndownService().turndown(result.value).trimEnd();
  return markdown;
}

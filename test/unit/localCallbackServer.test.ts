import { describe, expect, it } from "vitest";

import { renderResponseHtml } from "../../src/utils/localCallbackServer";

describe("renderResponseHtml", () => {
  it("escapes dynamic title and body content", () => {
    const html = renderResponseHtml('<script>alert("title")</script>', "Body with <b>tags</b> & quotes \" '");

    expect(html).toContain("&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;");
    expect(html).toContain("Body with &lt;b&gt;tags&lt;/b&gt; &amp; quotes &quot; &#39;");
    expect(html).not.toContain("<script>alert(\"title\")</script>");
  });
});

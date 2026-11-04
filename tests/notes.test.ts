import { test } from "node:test";
import assert from "node:assert/strict";
import { DS, NotionFail, NotionReader, normBlock, safeHref } from "../server/notion.js";

const PID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const rt = (t: string, extra: Record<string, unknown> = {}) => [{ plain_text: t, annotations: {}, ...extra }];

test("notes are read only from real project pages", async () => {
  const seen: any[] = [];
  const replies = [
    { object: "page", id: PID, parent: { type: "data_source_id", data_source_id: DS.projects } },
    { results: [
      { object: "block", type: "heading_2", heading_2: { rich_text: rt("Contacts") } },
      { object: "block", type: "paragraph", paragraph: { rich_text: [{ plain_text: "Call ", annotations: {} }, { plain_text: "Sam", annotations: { bold: true }, href: "tel:+15551234" }] } },
      { object: "block", type: "to_do", to_do: { rich_text: rt("Book van"), checked: true } },
      { object: "block", type: "toggle", has_children: true, toggle: { rich_text: rt("Old") } },
      { object: "block", type: "image", image: {} },
      { object: "block", type: "unsupported" },
    ], has_more: false },
  ];
  const f = (async (url: string, init: any) => { seen.push([init.method, url]); return new Response(JSON.stringify(replies.shift())); }) as typeof fetch;
  const r = await new NotionReader("t", f).projectContent(PID);
  assert.deepEqual(seen.map((x) => x[0]), ["GET", "GET"], "only reads");
  assert.match(seen[1][1], new RegExp(`/blocks/${PID}/children\\?page_size=100$`));
  assert.deepEqual(r.blocks.map((b) => b.kind), ["h2", "p", "todo", "toggle", "other"]);
  assert.deepEqual(r.blocks[1].text[1], { t: "Sam", b: true, href: "tel:+15551234" });
  assert.equal(r.blocks[2].checked, true);
  assert.equal(r.blocks[3].more, true);
  assert.equal(r.truncated, false);

  const bill = (async () => new Response(JSON.stringify({ object: "page", parent: { type: "data_source_id", data_source_id: DS.bills } }))) as typeof fetch;
  await assert.rejects(new NotionReader("t", bill).projectContent(PID), (e: unknown) => e instanceof NotionFail && e.code === "not_found");
  await assert.rejects(new NotionReader("t", bill).projectContent("../../users"), (e: unknown) => e instanceof NotionFail && e.code === "bad_request");
});

test("only safe links pass through", () => {
  assert.equal(safeHref("javascript:alert(1)"), undefined);
  assert.equal(safeHref("data:text/html,hi"), undefined);
  assert.equal(safeHref("/abc123"), "https://www.notion.so/abc123");
  assert.equal(safeHref("mailto:a@b.co"), "mailto:a@b.co");
  assert.equal(normBlock({ object: "block", type: "bookmark", bookmark: { url: "javascript:x", caption: [] } }), null);
});

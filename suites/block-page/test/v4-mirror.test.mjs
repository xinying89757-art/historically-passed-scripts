import test from "node:test";
import assert from "node:assert/strict";
import { adoptExistingV4TargetState, createV4MirrorState, summarizeV4Mirror } from "../src/v4-mirror.mjs";

function fixture() {
  const sourceBlockState = {
    pages: [{ name: "页面一", path: "/one", publicUrl: "http://example.com/one", category: "图片集", block_ids: ["1", "2"] }],
    records: [
      { block_id: "1", app_name: "支持区块", editor_dom_id: "source-1", status: "added" },
      { block_id: "2", app_name: "不支持区块", editor_dom_id: "source-2", status: "added" },
    ],
  };
  const sourceFirstRichTextState = {
    page_name: "页面一",
    page_path: "/one",
    records: [
      {
        block_id: "1",
        status: "verified",
        editors: [{ editor_index: 1, field_name: "标题", expected_text: "唯一中文标题", expected_level: "H2" }],
      },
      { block_id: "2", status: "unsupported_no_rich_text", editors: [] },
    ],
  };
  return {
    sourceBlockState,
    sourceFirstRichTextState,
    sourceBatchRichTextState: { pages: [] },
    environment: {
      entryUrl: "https://www.leadong.com/website.html",
      siteName: "4.0编辑器",
      siteLanguage: "英语",
      proxyServer: "",
      userDataDir: ".auth/no-proxy",
      sourceBlockStateFile: "blocks.json",
      sourceFirstRichTextStateFile: "first.json",
      sourceBatchRichTextStateFile: "batch.json",
    },
  };
}

test("无代理镜像按源页面顺序复制区块和精确H2数据", () => {
  const state = createV4MirrorState(fixture());
  assert.equal(state.environment.proxy_server, "");
  assert.deepEqual(state.pages[0].records.map((record) => record.block_id), ["1", "2"]);
  assert.equal(state.pages[0].records[0].expected_editors[0].expected_text, "唯一中文标题");
  assert.equal(state.pages[0].records[0].expected_editors[0].expected_level, "H2");
  assert.equal(state.pages[0].records[1].expected_rich_text_status, "unsupported_no_rich_text");
});

test("无代理镜像汇总分别统计区块、H2和不支持项", () => {
  const state = createV4MirrorState(fixture());
  state.pages[0].status = "complete";
  state.pages[0].records[0].block_status = "verified";
  state.pages[0].records[0].rich_text_status = "verified";
  state.pages[0].records[0].verified_rich_text_count = 1;
  state.pages[0].records[1].block_status = "verified";
  state.pages[0].records[1].rich_text_status = "confirmed_unsupported";
  assert.deepEqual(summarizeV4Mirror(state), {
    pages: 1,
    completePages: 1,
    pendingPages: 0,
    blocks: 2,
    verifiedBlocks: 2,
    expectedRichTexts: 1,
    verifiedRichTexts: 1,
    expectedUnsupported: 1,
    confirmedUnsupported: 1,
    preservedExtras: 0,
    failures: 0,
  });
});

test("源页面存在重复区块ID时拒绝生成镜像任务", () => {
  const value = fixture();
  value.sourceBlockState.pages[0].block_ids = ["1", "1"];
  assert.throws(() => createV4MirrorState(value), /源区块ID重复/u);
});

test("复用无代理已有同ID区块并保留明确的额外历史区块", () => {
  const state = createV4MirrorState(fixture());
  const target = {
    records: [
      { page_name: "页面一", block_id: "1", slot_index: 2, editor_dom_id: "target-1", status: "added" },
      { page_name: "页面一", block_id: "99", slot_index: 1, editor_dom_id: "target-extra", status: "added" },
    ],
  };
  adoptExistingV4TargetState(state, target, { allowExistingExtraBlocks: true });
  assert.equal(state.pages[0].records[0].target_editor_dom_id, "target-1");
  assert.equal(state.pages[0].records[0].block_status, "existing_to_verify");
  assert.equal(state.pages[0].records[1].block_status, "pending");
  assert.deepEqual(state.pages[0].existing_extra_blocks.map((record) => record.block_id), ["99"]);
});

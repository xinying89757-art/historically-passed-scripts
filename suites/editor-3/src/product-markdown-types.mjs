import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = path.resolve(packageDir, "../..");
const outputRoot = path.join(workspaceDir, "outputs", "product-markdown-types");
const runId = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
const runDir = path.join(outputRoot, runId);
const baseUrl = (process.env.UI_BASE_URL ?? "http://site.example.invalid").replace(/\/$/u, "");
const productName = process.env.PRODUCT_NAME ?? "测试markdown";
const loginUrl = process.env.UI_ADMIN_LOGIN_URL ?? "https://admin.example.invalid/login.html";
const portalUrl = process.env.UI_ADMIN_URL ?? "https://admin.example.invalid/website.html";
const proxyServer = process.env.UI_PROXY && process.env.UI_PROXY !== "none" ? process.env.UI_PROXY : undefined;
const headless = process.argv.includes("--headless");
const argValue = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const scanOnly = process.argv.includes("--scan-only") || process.argv.includes("--dry-run");
const focusType = argValue("--type") ?? process.env.UI_FOCUS_TYPE;
const focusSetting = argValue("--setting");
const focusValue = argValue("--value");
const saveBatch = process.argv.includes("--save-batch");
const inspectOptions = process.argv.includes("--inspect-options");
const markerPrefix = `PW-${runId}`;

function assert(condition, message) { if (!condition) throw new Error(message); }
function hasBlockingSettings(settings) { return settings.some((setting) => !["passed","unsupported","not_applicable","action"].includes(setting.status)); }
function record(report, type, status, detail = {}) {
  const item = { type, status, ...detail };
  report.checks.push(item);
  console.log(`${status.toUpperCase()} ${type}${detail.reason ? `: ${detail.reason}` : ""}`);
}
async function gotoWithRetry(page, url, attempts = 3) {
  let error;
  for (let i = 0; i < attempts; i += 1) {
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }); return; }
    catch (e) { error = e; if (i < attempts - 1) await page.waitForTimeout(800 * (i + 1)); }
  }
  throw error;
}

async function openProduct(context, credentials) {
  const portal = await context.newPage();
  await gotoWithRetry(portal, loginUrl);
  if ((await portal.locator("#loginName").isVisible().catch(() => false)) || portal.url().includes("/login")) {
    const loginName=portal.locator("#loginName");
    try { await loginName.waitFor({ state: "visible", timeout: 15_000 }); }
    catch(error) {
      await portal.screenshot({path:path.join(runDir,"后台-登录页异常.png"),fullPage:true}).catch(()=>undefined);
      const body=(await portal.locator("body").innerText().catch(()=>"" )).slice(0,1_000);
      throw new Error(`管理员登录框未加载；页面=${portal.url()}；标题=${await portal.title().catch(()=>"")}；页面摘要=${body}；原因=${String(error?.message??error)}`);
    }
    await portal.locator("#loginName").fill(credentials.account);
    await portal.locator("#password").fill(credentials.password);
    await portal.locator("#loginSubmit").click();
    await portal.waitForTimeout(3_500);
  }
  await gotoWithRetry(portal, portalUrl);
  const siteLink = portal.locator("a").filter({ hasText: baseUrl }).first();
  let siteReady=await siteLink.waitFor({ state: "visible", timeout: 8_000 }).then(()=>true).catch(()=>false);
  if(!siteReady&&credentials.account&&credentials.password) {
    await gotoWithRetry(portal,loginUrl);
    await portal.locator("#loginName").waitFor({state:"visible",timeout:15_000});
    await portal.locator("#loginName").fill(credentials.account);
    await portal.locator("#password").fill(credentials.password);
    await portal.locator("#loginSubmit").click();
    await portal.waitForTimeout(3_500);
    await gotoWithRetry(portal,portalUrl);
    siteReady=await siteLink.waitFor({state:"visible",timeout:15_000}).then(()=>true).catch(()=>false);
  }
  if(!siteReady) await (async()=>{
    const pageText = (await portal.locator("body").innerText().catch(() => "")).slice(0, 500);
    await portal.screenshot({ path: path.join(runDir, "后台-站点入口失败.png") }).catch(() => undefined);
    throw new Error(`管理员后台未显示目标站点 ${baseUrl}；当前页面=${portal.url()}；页面摘要=${pageText}`);
  })();
  const siteCard = siteLink.locator('xpath=ancestor::div[contains(@class,"contentShow")]');
  const newPage = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
  await siteCard.getByText("内容管理", { exact: true }).click();
  const adminPage = (await newPage) ?? portal;
  await adminPage.waitForLoadState("domcontentloaded").catch(() => undefined);
  let productFrame = adminPage.frame({ name: "prod" });
  for (let i = 0; !productFrame && i < 80; i += 1) { await adminPage.waitForTimeout(400); productFrame = adminPage.frame({ name: "prod" }); }
  if(!productFrame) {
    await adminPage.screenshot({path:path.join(runDir,"后台-产品iframe失败.png")}).catch(()=>undefined);
    const frames=adminPage.frames().map((f)=>f.url().split("?")[0]);const body=(await adminPage.locator("body").innerText().catch(()=>"")).slice(0,600);
    throw new Error(`内容管理的产品 iframe 未加载；页面=${adminPage.url()}；frames=${frames.join(" | ")}；页面摘要=${body}`);
  }
  const productLink = productFrame.getByRole("link", { name: productName, exact: true });
  await productLink.waitFor({ state: "visible", timeout: 30_000 });
  await productLink.click();
  await productFrame.locator("#addProd_Desc").waitFor({ state: "visible", timeout: 25_000 });
  await adminPage.waitForTimeout(700);
  return { portal, adminPage, productFrame };
}

async function getEditor(productFrame, adminPage) {
  const group = productFrame.locator("h3.phoenix_tipTapRichText").filter({ hasText: "Product Description" }).first();
  assert(await group.count(), "未找到 Product Description 新版内容编辑器");
  const wrapperFrame = adminPage.frames().findLast((f) => f.url().includes("/tiptapEditor/editor_frame.jsp"));
  assert(wrapperFrame, "内容编辑器工具栏 frame 未加载");
  let editorFrame = adminPage.frames().findLast((f) => f.url().includes("/tiptapEditor/editor.html"));
  for (let i = 0; !editorFrame && i < 40; i += 1) { await adminPage.waitForTimeout(400); editorFrame = adminPage.frames().findLast((f) => f.url().includes("/tiptapEditor/editor.html")); }
  assert(editorFrame, "内容编辑器 frame 未加载");
  const content = editorFrame.locator(".ProseMirror[contenteditable=true]").first();
  await content.waitFor({ state: "visible", timeout: 15_000 });
  for (let i = 0; i < 60 && !(await content.innerText()).trim(); i += 1) await adminPage.waitForTimeout(250);
  assert((await content.innerText()).trim(), "产品描述未加载到编辑器");
  return { editorFrame, wrapperFrame, content };
}

async function detectNodeTypes(content) {
  return content.evaluate((root) => {
    const count = (selector) => root.querySelectorAll(selector).length;
    const languages = [...new Set([...root.querySelectorAll("pre code[class]")].flatMap((node) => [...node.classList].filter((c) => c.startsWith("language-")).map((c) => c.slice(9))))];
    const inventory = {};
    for (const node of root.querySelectorAll("*")) inventory[node.tagName.toLowerCase()] = (inventory[node.tagName.toLowerCase()] ?? 0) + 1;
    return {
      headings: Object.fromEntries(["h1","h2","h3","h4","h5","h6"].map((tag) => [tag.toUpperCase(), count(tag)])),
      paragraphs: count("p"),
      marks: { bold: count("strong,b"), italic: count("em,i"), underline: count("u"), strike: count("s,del,strike"), inlineCode: count("code:not(pre code)") },
      links: count("a[href]"),
      lists: { unordered: count("ul"), ordered: count("ol"), nested: count("ul ul,ol ol,ul ol,ol ul"), task: count('[data-type="taskList"],[data-type="taskItem"],input[type="checkbox"]') },
      quotes: { blockquote: count("blockquote"), nested: count("blockquote blockquote") },
      codeBlocks: { total: count("pre code"), withoutLanguage: count("pre > code:not([class*='language-'])"), languages },
      tables: { tables: count("table"), cells: count("td,th"), headers: count("th") },
      images: count("img"), dividers: count("hr,.qc-divider-wrapper,[data-type='horizontalRule']"),
      math: count("math,.math-inline,.math-display,[data-type*='math']"), inventory,
      emojiCharacters: [...root.innerText].filter((c) => /\p{Extended_Pictographic}/u.test(c)).length,
    };
  });
}

async function buildTypeSamples(content) {
  const samples=await content.evaluate((root) => {
    const samples = [];
    const overlaps = (node) => samples.some((sample) => {
      const other = root.querySelectorAll(sample.selector)[sample.index];
      return other && (other === node || other.contains(node) || node.contains(other));
    });
    const add = (type, selector, { disjoint = false, predicate = () => true } = {}) => {
      const nodes = [...root.querySelectorAll(selector)];
      const index = nodes.findIndex((node) => (node.textContent ?? "").trim() && predicate(node) && (!disjoint || !overlaps(node)));
      if (index < 0) return;
      const node = nodes[index];
      const path = [];
      for (let current = node; current && current !== root; current = current.parentElement) {
        const siblings = [...current.parentElement.children].filter((sibling) => sibling.tagName === current.tagName);
        path.unshift({ tag: current.tagName.toLowerCase(), index: siblings.indexOf(current) });
      }
      samples.push({ type, selector, index, fingerprint: { path, text: (node.textContent ?? "").replace(/\s+/gu, " ").trim() } });
    };
    for (let n = 1; n <= 6; n += 1) add(`标题 H${n}`, `h${n}`, { disjoint: true });
    add("普通段落", "p:not(blockquote p):not(li p):not(td p):not(th p):not(h1 p):not(h2 p):not(h3 p):not(h4 p):not(h5 p):not(h6 p)", { disjoint: true });
    add("加粗文本", "strong,b", { disjoint: true }); add("斜体文本", "em,i", { disjoint: true });
    add("下划线文本", "u", { disjoint: true }); add("删除线文本", "s,del,strike", { disjoint: true });
    add("行内代码", "code:not(pre code)", { disjoint: true }); add("链接文本", "a[href]", { disjoint: true });
    add("无序列表", "ul > li p", { disjoint: true });
    add("嵌套列表", "ul ul > li p,ol ul > li p,ul ol > li p,ol ol > li p", { disjoint: true });
    add("有序列表", "ol > li p", { disjoint: true }); add("任务列表", '[data-type="taskList"] li p,[data-type="taskItem"] p', { disjoint: true });
    add("引用", "blockquote > p", { disjoint: true }); add("嵌套引用", "blockquote blockquote p", { disjoint: true });
    const languages = [...new Set([...root.querySelectorAll("pre code[class]")].flatMap((node) => [...node.classList].filter((c) => c.startsWith("language-")).map((c) => c.slice(9))))];
    for (const language of languages) add(`代码块（语言：${language}）`, `pre code.language-${CSS.escape(language)}`, { disjoint: true });
    add("无语言代码块", "pre > code:not([class*='language-'])", { disjoint: true });
    add("表格单元格", "table td", { disjoint: true }); add("表格表头", "table th", { disjoint: true });
    add("Emoji 文本", "p,li,td,th,h1,h2,h3,h4,h5,h6", { predicate: (node) => /\p{Extended_Pictographic}/u.test(node.textContent ?? "") });
    return samples;
  });
  return samples.map((sample)=>({
    ...sample,
    fingerprint:{
      path:sample.fingerprint.path,
      text:sample.fingerprint.text.slice(0,120),
      textLength:sample.fingerprint.text.length,
      textHash:createHash("sha256").update(sample.fingerprint.text).digest("hex"),
    },
  }));
}

async function locateSample(content,sample) {
  const candidates=await content.locator(sample.selector).evaluateAll((nodes)=>nodes.map((node,index)=>{
    const path=[];
    const root=node.closest(".ProseMirror");
    for(let current=node;current&&current!==root;current=current.parentElement){
      const siblings=[...current.parentElement.children].filter((sibling)=>sibling.tagName===current.tagName);
      path.unshift({tag:current.tagName.toLowerCase(),index:siblings.indexOf(current)});
    }
    return {index,text:(node.textContent??"").replace(/\s+/gu," ").trim(),path};
  }));
  const matching=candidates.filter((candidate)=>createHash("sha256").update(candidate.text).digest("hex")===(sample.fingerprint?.textHash??createHash("sha256").update(sample.fingerprint?.text??"").digest("hex")));
  if(matching.length===1)return {target:content.locator(sample.selector).nth(matching[0].index),method:"content-fingerprint",matches:1,path:matching[0].path};
  const oldPath=sample.fingerprint?.path??[];
  const pathMatches=matching.filter((candidate)=>JSON.stringify(candidate.path)===JSON.stringify(oldPath));
  if(pathMatches.length===1)return {target:content.locator(sample.selector).nth(pathMatches[0].index),method:"content-and-path",matches:matching.length,path:pathMatches[0].path};
  return {target:null,method:"ambiguous",matches:matching.length,candidatePaths:matching.map((candidate)=>candidate.path)};
}

function batchMarkerFor(type,fingerprint,targetText) {
  const legacy=`⟦PW-MD-${Buffer.from(type).toString("hex").slice(0,12)}⟧`;
  if(targetText.includes(legacy))return legacy;
  const identity=`${type}\n${fingerprint?.textHash??fingerprint?.text??""}`;
  return `⟦PW-MD-${createHash("sha256").update(identity).digest("hex").slice(0,24)}⟧`;
}

async function describeContentStructure(content) {
  return content.evaluate((root) => {
    const serialize = (node) => node.nodeType === Node.TEXT_NODE ? node.textContent : ({
      tag: node.tagName.toLowerCase(),
      attrs: [...node.attributes].filter((a) => !/^data-(?:node-view|react|editor)/iu.test(a.name)).map((a) => [a.name, a.value]).sort(([a], [b]) => a.localeCompare(b)),
      children: [...node.childNodes].map(serialize),
    });
    return [...root.children].map(serialize);
  });
}

async function contentIntegritySnapshot(content,target,marker,setting="") {
  return content.evaluate((root,{marker:needle,settingName})=>{
    const markerWalker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let markerNode;
    while((markerNode=markerWalker.nextNode()))if(markerNode.textContent.includes(needle))break;
    if(!markerNode)return {found:false,reason:"代表标记在结构快照中不存在"};
    const block=markerNode.parentElement.closest("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th,figure")??markerNode.parentElement;
    const path=[];
    for(let current=block;current&&current!==root;current=current.parentNode)path.unshift([...current.parentNode.childNodes].indexOf(current));
    const clone=root.cloneNode(true);let cloneBlock=clone;
    for(const childIndex of path)cloneBlock=cloneBlock.childNodes[childIndex];
    const wrapper=clone.ownerDocument.createElement("span");wrapper.setAttribute("data-pw-integrity-target","true");
    cloneBlock.replaceWith(wrapper);
    const expectedBlock=block.cloneNode(true);
    const walk=document.createTreeWalker(expectedBlock,NodeFilter.SHOW_TEXT);let textNode;let parentOfMarker=null;
    while((textNode=walk.nextNode()))if(textNode.textContent.includes(needle)){
      textNode.textContent=textNode.textContent.replace(needle,"\u0000PW_TARGET\u0000");parentOfMarker=textNode.parentElement;break;
    }
    while(parentOfMarker&&parentOfMarker!==expectedBlock){
      if(parentOfMarker.textContent!=="\u0000PW_TARGET\u0000")break;
      const parent=parentOfMarker.parentNode;while(parentOfMarker.firstChild)parent.insertBefore(parentOfMarker.firstChild,parentOfMarker);parent.removeChild(parentOfMarker);parentOfMarker=parent;
    }
    const cleanup=document.createTreeWalker(expectedBlock,NodeFilter.SHOW_TEXT);const cleanupNodes=[];let text;
    while((text=cleanup.nextNode()))cleanupNodes.push(text);
    for(const node of cleanupNodes)node.textContent=node.textContent.replace("\u0000PW_TARGET\u0000","");
    expectedBlock.normalize();
    const cleanAttrs=(node,omitStyleProperty="")=>[...node.attributes].map((attr)=>{
      if(attr.name==="class"&&settingName==="字体大小")return [attr.name,attr.value.split(/\s+/u).filter((token)=>!/^ld-qc-heading\d+$/u.test(token)).join(" ")];
      if(attr.name!=="style"||!omitStyleProperty)return [attr.name,attr.value];
      const style=node.ownerDocument.createElement("span").style;style.cssText=attr.value;style.removeProperty(omitStyleProperty);
      return [attr.name,style.cssText];
    }).filter(([,value])=>value!=="").sort(([a],[b])=>a.localeCompare(b));
    const ignoredStyleProperty=settingName==="行间距"?"line-height":settingName==="文本对齐"||settingName==="图片对齐"?"text-align":"";
    const ancestors=[];for(let node=block.parentElement;node&&node!==root;node=node.parentElement)ancestors.unshift({tag:node.tagName.toLowerCase(),attrs:cleanAttrs(node)});
    return {
      found:true,
      text:root.innerText.replaceAll(needle,""),
      outsideTargetHtml:clone.innerHTML,
      targetBlock:{tag:block.tagName.toLowerCase(),attrs:cleanAttrs(block,ignoredStyleProperty),ancestors,normalizedChildren:expectedBlock.innerHTML},
    };
  },{marker,settingName:setting});
}

function compareIntegritySnapshots(before,after) {
  if(!before?.found||!after?.found)return {matches:false,differences:{snapshotMissing:{before:Boolean(before?.found),after:Boolean(after?.found)}}};
  const differences={};
  for(const key of ["text","outsideTargetHtml"])if(before[key]!==after[key])differences[key]={beforeLength:before[key]?.length,afterLength:after[key]?.length};
  if(JSON.stringify(before.targetBlock)!==JSON.stringify(after.targetBlock))differences.targetBlock={before:before.targetBlock,after:after.targetBlock};
  return {matches:Object.keys(differences).length===0,differences};
}

async function insertMarker({ target, content, editorFrame, marker, code = false }) {
  await target.scrollIntoViewIfNeeded().catch(()=>undefined);
  if (code) {
    await target.click({ force: true });
    await target.evaluate((el) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let last;
      while (walk.nextNode()) last = walk.currentNode;
      if (!last) return;
      const range = document.createRange(); range.setStart(last, last.textContent.length); range.collapse(true);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      el.closest('[contenteditable="true"]')?.focus({ preventScroll: true });
    });
    await editorFrame.page().keyboard.insertText(marker);
  } else {
    const selected = await target.evaluate((el) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node;
      while ((node = walk.nextNode())) if (node.textContent.trim()) break;
      if (!node) return "";
      const len = Math.min(32, node.textContent.length); const range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, len);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); return range.toString();
    });
    assert(selected.trim(), "代表节点没有可编辑文本");
    await target.click({ force: true });
    await target.evaluate((el) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node;
      while ((node = walk.nextNode())) if (node.textContent.trim()) break;
      if (!node) return;
      const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(32, node.textContent.length));
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);el.closest('[contenteditable="true"]')?.focus({preventScroll:true});
    });
    await editorFrame.page().keyboard.insertText(`${selected}${marker}`);
  }
  assert((await content.innerText()).includes(marker), `标记没有写入编辑器：${marker}`);
}

async function selectMarker(content, marker) {
  return content.evaluate((root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes = []; let full = ""; let node;
    while ((node = walker.nextNode())) { nodes.push({ node, start: full.length, end: full.length + node.textContent.length }); full += node.textContent; }
    const startAt = full.indexOf(text); if (startAt < 0) return false;
    const point = (at, start) => {
      const entry = start ? nodes.find((x) => at >= x.start && at < x.end) : [...nodes].reverse().find((x) => at > x.start && at <= x.end);
      return entry && { node: entry.node, offset: at - entry.start };
    };
    const a = point(startAt, true); const b = point(startAt + text.length, false); if (!a || !b) return false;
    const range = document.createRange(); range.setStart(a.node,a.offset); range.setEnd(b.node,b.offset);
    (a.node.parentElement?.closest("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th")??a.node.parentElement)?.scrollIntoView({block:"center",inline:"nearest"});
    root.focus({ preventScroll:true }); const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);return selection.toString()===text;
  }, marker);
}

async function markerState(content, marker) {
  return content.evaluate((root, text) => {
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
    while((node=walker.nextNode())) if(node.textContent.includes(text)) {
      const el=node.parentElement; const css=getComputedStyle(el); const block=el.closest("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th,figure")??el;
      const bs=getComputedStyle(block); const decorations=new Set(); const marks=[]; let bg="rgba(0, 0, 0, 0)";
      for(let cur=el;cur&&cur!==root;cur=cur.parentElement){const s=getComputedStyle(cur);for(const d of s.textDecorationLine.split(/\s+/u))if(d&&d!=="none")decorations.add(d);if(["STRONG","B","EM","I","U","S","DEL","STRIKE","CODE"].includes(cur.tagName))marks.push(cur.tagName.toLowerCase());if(bg==="rgba(0, 0, 0, 0)"&&s.backgroundColor!=="rgba(0, 0, 0, 0)"&&s.backgroundColor!=="transparent")bg=s.backgroundColor;}
      return {found:true,marks:[...new Set(marks)],inline:{fontFamily:css.fontFamily,fontWeight:css.fontWeight,fontStyle:css.fontStyle,textDecoration:[...decorations].join(" ")||"none",fontSize:css.fontSize,color:css.color,backgroundColor:bg},block:{tag:block.tagName.toLowerCase(),lineHeight:bs.lineHeight,textAlign:bs.textAlign},href:el.closest("a[href]")?.getAttribute("href")??null};
    }
    return {found:false};
  }, marker);
}

async function markerStructure(content, marker) {
  return content.evaluate((root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) if (node.textContent.includes(text)) break;
    if (!node) return null;
    const block = node.parentElement.closest("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th,table") ?? node.parentElement;
    const chain = [];
    for (let current = block; current && current !== root; current = current.parentElement) {
      if (["UL","OL","LI","BLOCKQUOTE","TABLE","THEAD","TBODY","TR","TD","TH","PRE","H1","H2","H3","H4","H5","H6","P"].includes(current.tagName)) {
        chain.unshift({ tag: current.tagName.toLowerCase(), className: current.className, attrs: [...current.attributes].filter((attr) => ["data-type","data-language","start","reversed"].includes(attr.name)).map((attr) => [attr.name, attr.value]) });
      }
    }
    return chain;
  }, marker);
}

async function visibleBubbleControls(frame) {
  const visible=frame.locator(".bubble-toolbar:visible [title]");
  await visible.first().waitFor({state:"visible",timeout:1_500}).catch(()=>undefined);
  return visible.evaluateAll((nodes) => nodes.filter((n) => n.getClientRects().length && getComputedStyle(n).visibility !== "hidden").map((n) => ({ title:n.getAttribute("title")??"", text:n.textContent?.trim()??"", html:n.outerHTML.slice(0,300) })));
}
async function visibleSpecialControls(frame) {
  return frame.locator(".tb-btn[title],.tb-group[title],button[title],[role=button][title]").evaluateAll((nodes) => nodes.filter((n) => n.getClientRects().length && getComputedStyle(n).visibility !== "hidden").map((n) => ({ title:n.getAttribute("title")??"", text:n.textContent?.trim()??"", parent:n.parentElement?.className??"" })).filter((x)=>x.title));
}

function normalizeControlTitle(title) { return title.replace(/\s*[:：].*$/u, "").trim(); }
const actionTitles = new Set(["上移","下移","删除","替换图片","表格编辑"]);
const knownSettings = new Set(["字体大小","字号","行间距","设置链接","背景颜色","字体颜色","加粗","斜体","下划线","删除线","清除格式","转换为","图片对齐","文本对齐","图片样式","分割线颜色","分割线粗细","表格对齐","表格铺满内容区","列宽最小值","表格边框颜色"]);

async function applyTextSetting({ type, title, marker, editorFrame, content }) {
  if (!(await selectMarker(content, marker))) return { setting:title,status:"failed",reason:"无法选择代表标记" };
  await editorFrame.page().waitForTimeout(120);
  const alias=title==="字号"?"字体大小":title==="文本对齐"?"图片对齐":title;
  const control=editorFrame.locator(`.bubble-toolbar:visible [title*="${alias}"]`).last();
  await control.waitFor({state:"visible",timeout:1_200}).catch(()=>undefined);
  if (!(await control.count())||!(await control.isVisible().catch(()=>false))) return {setting:title,status:"blocked",reason:"重新选择代表标记后，当前可见工具栏中找不到该控件"};
  const before=await markerState(content,marker);
  const toggleSetting=["加粗","斜体","下划线","删除线"].includes(title);
  if(!toggleSetting&&title!=="转换为") { await control.click({force:true}); await editorFrame.page().waitForTimeout(120); }
  const popper=editorFrame.locator(".el-popper:visible,[role=menu]:visible,[role=listbox]:visible").last();
  if(title==="字体大小"||title==="字号"||title==="行间距") {
    const choice=focusValue??(title==="行间距"?"2.2":(before.inline.fontSize==="18px"?"22px":"18px"));
    const options=popper.locator(".el-dropdown-menu__item,.el-select-dropdown__item,[role=option],[role=menuitem]");
    let option=options.filter({hasText:choice}).last();
    if(!(await option.count())) option=popper.getByText(choice,{exact:true}).last();
    if(!(await option.count())||!(await option.isVisible().catch(()=>false)))return {setting:title,status:"failed",reason:`当前菜单无值 ${choice}`,menu:await popper.innerText().catch(()=>"")};
    await option.scrollIntoViewIfNeeded();
    await option.click();
    await editorFrame.page().waitForTimeout(220);
  } else if(title==="设置链接") {
    const input=editorFrame.locator(".link-input:visible").last(); if(!(await input.count()))return {setting:title,status:"failed",reason:"链接输入框未出现"};
    const href=`https://example.com/pw-check/${encodeURIComponent(marker)}`; await input.fill(href);
    const save=editorFrame.locator(".link-panel .save-btn:visible").last(); if(await save.count())await save.click();else await input.press("Enter").catch(()=>undefined);
  } else if(title==="字体颜色"||title==="背景颜色") {
    const input=editorFrame.locator(".text-color-picker-popper:visible .color-hex-value input:visible").last();
    if(!(await input.count()))return {setting:title,status:"failed",reason:"HEX 输入框未出现"};
    const hex=focusValue??(title==="字体颜色"?"13A8A8":"FFF0A8");await input.fill(hex.replace(/^#/u,""));await input.press("Enter").catch(()=>undefined);await editorFrame.page().waitForTimeout(450);
  } else if(["加粗","斜体","下划线","删除线"].includes(title)) {
    const expectedOn=focusValue!=="off"&&focusValue!=="false";
    const isOn={加粗:before.marks?.some((mark)=>["strong","b"].includes(mark)),斜体:before.marks?.some((mark)=>["em","i"].includes(mark)),下划线:before.marks?.includes("u"),删除线:before.marks?.some((mark)=>["s","del","strike"].includes(mark))} [title];
    if(isOn!==expectedOn){await control.click({force:true});await editorFrame.page().waitForTimeout(160);}
  } else if(title==="清除格式") {
    if(type.startsWith("代码块")&&before.marks?.every((mark)=>mark==="code")) return {setting:title,status:"not_applicable",reason:"该代码块没有可清除的行内样式；保留 code 节点本身"};
    const cleared=await markerState(content,marker);
    const changed=JSON.stringify(cleared)!==JSON.stringify(before);
    return {setting:title,status:changed?"passed":"failed",before,cleared,reason:changed?undefined:"清除格式后样式与结构没有变化"};
  } else if(title==="图片对齐"||title==="文本对齐") {
    if(type.startsWith("代码块")) return {setting:title,status:"not_applicable",reason:"该工具栏控件没有针对代码文本的对齐菜单选项"};
    const choice=focusValue??"居中";
    const alias={center:"居中",left:"左对齐",right:"右对齐",full:"铺满",justify:"铺满"}[choice.toLowerCase()]??choice;
    const option=editorFrame.locator(".el-popper:visible .el-dropdown-menu__item,[role=menu]:visible [role=menuitem]").filter({hasText:new RegExp(alias,"u")}).last();
    if(!(await option.count())||!(await option.isVisible().catch(()=>false)))return {setting:title,status:"blocked",reason:`对齐菜单没有可见选项 ${alias}`,menu:await editorFrame.locator(".el-popper:visible").last().innerText().catch(()=>"")};
    await option.click({force:true});await editorFrame.page().waitForTimeout(120);
    const after=await markerState(content,marker);const changed=after.block.textAlign==="center";
    const expected={居中:"center",左对齐:"left",右对齐:"right",铺满:"justify"}[alias]??alias;
    const verified=after.block.textAlign===expected;
    return {setting:title,status:verified?"passed":"failed",before,after,expected,reason:verified?undefined:`点击 ${alias} 后文本块对齐为 ${after.block.textAlign}`};
  } else if(title==="转换为") {
    const baseline=await markerStructure(content,marker);
    const openMenu=async()=>{
      if(!(await selectMarker(content,marker)))throw new Error("转换后无法重新选择代表文字");
      const trigger=editorFrame.locator('.bubble-toolbar:visible [title*="转换为"]').last();
      if(!(await trigger.count()))throw new Error("代表选区没有转换菜单按钮");
      await trigger.click({force:true});
      const menu=editorFrame.locator(".convert-panel:visible").last();
      await menu.waitFor({state:"visible",timeout:2_000});
      return menu.locator(".convert-btn");
    };
    const options=await openMenu();
    const count=await options.count();
    const initial=await options.evaluateAll((nodes)=>nodes.findIndex((node)=>node.classList.contains("active")));
    if(count<2||initial<0)return {setting:title,status:"unsupported",reason:"转换菜单没有多个有效选项",count,initial};
    const variants=[];
    for(let index=0;index<count;index+=1) {
      if(index===initial)continue;
      try {
        const menuOptions=await openMenu();
        const icon=await menuOptions.nth(index).locator("svg path").first().getAttribute("d").catch(()=>"");
        await menuOptions.nth(index).evaluate((element)=>element.click());
        let changedStructure=await markerStructure(content,marker);
        if(JSON.stringify(changedStructure)===JSON.stringify(baseline)) {
          for(let attempt=0;attempt<12;attempt+=1){await editorFrame.page().waitForTimeout(50);changedStructure=await markerStructure(content,marker);if(JSON.stringify(changedStructure)!==JSON.stringify(baseline))break;}
        }
        const after=await markerState(content,marker);
        const restoreOptions=await openMenu();
        await restoreOptions.nth(initial).evaluate((element)=>element.click());
        let restored=await markerStructure(content,marker);
        if(JSON.stringify(restored)!==JSON.stringify(baseline)) {
          for(let attempt=0;attempt<12;attempt+=1){await editorFrame.page().waitForTimeout(50);restored=await markerStructure(content,marker);if(JSON.stringify(restored)===JSON.stringify(baseline))break;}
        }
        const changed=JSON.stringify(changedStructure)!==JSON.stringify(baseline);
        const restoredOK=JSON.stringify(restored)===JSON.stringify(baseline);
        variants.push({optionIndex:index,iconPath:icon,changed,restored:restoredOK,after,restoredStructure:restored});
        if(!restoredOK)return {setting:title,status:"blocked",reason:`转换选项 ${index+1} 后无法用编辑器恢复原始结构`,before:baseline,variants};
      } catch(error) { variants.push({optionIndex:index,status:"blocked",reason:String(error?.message??error)});return {setting:title,status:"blocked",reason:"枚举某个转换选项或恢复原结构时受阻",before:baseline,variants}; }
    }
    const allChanged=variants.every((variant)=>variant.changed&&variant.restored);
    return {setting:title,status:allChanged?"passed":"failed",before:baseline,variants,reason:allChanged?undefined:"至少一个转换选项未改变结构或未恢复基线"};
  } else return {setting:title,status:"failed",reason:"尚未实现该设置项的行为与持久化断言"};
  const after=await markerState(content,marker);
  let changed=JSON.stringify(before)!==JSON.stringify(after);
  let failureReason;
  const markFor={"加粗":["strong","b"],"斜体":["em","i"],"下划线":["u"],"删除线":["s","del","strike"]}[title];
  if(markFor) {
    const isOn={加粗:after.marks?.some((mark)=>["strong","b"].includes(mark)),斜体:after.marks?.some((mark)=>["em","i"].includes(mark)),下划线:after.marks?.includes("u"),删除线:after.marks?.some((mark)=>["s","del","strike"].includes(mark))} [title];
    const expectedOn=focusValue!=="off"&&focusValue!=="false";
    changed=isOn===expectedOn;
  }
  if(title==="设置链接")changed=Boolean(after.href?.includes(encodeURIComponent(marker)));
  if(title==="字体大小") {
    changed=after.inline.fontSize!==before.inline.fontSize;
    const collateral=[];
    for(const key of ["color","backgroundColor","textDecoration"])if(after.inline[key]!==before.inline[key])collateral.push(`inline.${key}`);
    if(JSON.stringify(after.marks??[])!==JSON.stringify(before.marks??[]))collateral.push("marks");
    if(after.href!==before.href)collateral.push("href");
    if(collateral.length){changed=false;failureReason=`字号调整时额外改变了 ${collateral.join(", ")}，按产品效果缺陷处理`}
  }
  if(title==="字体颜色")changed=after.inline.color!==before.inline.color;
  if(title==="背景颜色")changed=after.inline.backgroundColor!==before.inline.backgroundColor;
  return {setting:title,status:changed?"passed":"failed",before,after,reason:changed?undefined:failureReason??"点击设置后标记样式没有变化"};
}

async function inspectBubbleOptions({ type, marker, controls, editorFrame, content, target }) {
  const rows = [];
  const finiteSettings = new Set(["字体大小","行间距","转换为","图片对齐"]);
  const visiblePopperIds = async () => editorFrame.locator(".el-popper:visible,[role=menu]:visible,[role=listbox]:visible,.convert-panel:visible").evaluateAll((nodes) => nodes.map((node) => `${node.tagName.toLowerCase()}#${node.id}.${String(node.className).replace(/\s+/gu,".")}`));
  for (const control of controls) {
    const rawTitle = control.title;
    const title = normalizeControlTitle(rawTitle);
    if (!finiteSettings.has(title)) continue;
    await target.scrollIntoViewIfNeeded().catch(()=>undefined);
    await target.click({force:true}).catch(()=>undefined);
    if (!(await selectMarker(content, marker))) { rows.push({ setting: title, status: "blocked", reason: "无法恢复代表文本选区" }); continue; }
    const alreadyOpen=editorFrame.locator('.bubble-toolbar:visible [aria-expanded="true"]');
    for(let index=await alreadyOpen.count()-1;index>=0;index-=1)await alreadyOpen.nth(index).click({force:true}).catch(()=>undefined);
    await editorFrame.page().keyboard.press("Escape").catch(()=>undefined);
    const selectorTitle = title === "文本对齐" ? "图片对齐" : title;
    const button = editorFrame.locator(`.bubble-toolbar:visible [title*="${selectorTitle}"]`).last();
    if (!(await button.count())||!(await button.isVisible().catch(()=>false))) { rows.push({ setting: title, status: "blocked", reason: "代表选区下找不到该菜单" }); continue; }
    const beforePoppers=await visiblePopperIds();
    const triggerId=await button.getAttribute("id").catch(()=>null);
    const controlledId=await button.getAttribute("aria-controls").catch(()=>null);
    const triggerClass=await button.getAttribute("class").catch(()=>null);
    await button.click({ force: true });
    const controlled=controlledId?editorFrame.locator(`#${controlledId}`):null;
    const isConversion=title==="转换为";
    let popper = isConversion?editorFrame.locator(".convert-panel:visible").last():controlled&&await controlled.count()&&await controlled.isVisible().catch(()=>false)?controlled:editorFrame.locator(".el-popper:visible,[role=menu]:visible,[role=listbox]:visible").last();
    await popper.waitFor({ state: "visible", timeout: 1_200 }).catch(() => undefined);
    const afterPoppers=await visiblePopperIds();
    const controlledVisible=Boolean(controlled&&await controlled.isVisible().catch(()=>false));
    const ariaExpanded=await button.getAttribute("aria-expanded").catch(()=>null);
    const openedNew=afterPoppers.some((id)=>!beforePoppers.includes(id))||controlledVisible||ariaExpanded==="true";
    if(!isConversion&&!openedNew) {
      rows.push({setting:title,status:"blocked",reason:"点击控件后没有打开 aria-controls 菜单或出现新的可见菜单",beforePoppers,afterPoppers,triggerId,controlledId,ariaExpanded});
      continue;
    }
    let optionSelector=isConversion?".convert-btn":".el-dropdown-menu__item,.el-select-dropdown__item,[role=option],[role=menuitem],button";
    let optionLocator = popper.locator(optionSelector);
    let optionCount = await optionLocator.evaluateAll((nodes)=>nodes.filter((node)=>node.getClientRects().length&&getComputedStyle(node).visibility!=="hidden").length);
    if(!optionCount) {
      const visiblePoppers=editorFrame.locator(".el-popper:visible,[role=menu]:visible,[role=listbox]:visible");
      for(let popperIndex=await visiblePoppers.count()-1;popperIndex>=0;popperIndex-=1) {
        const candidate=visiblePoppers.nth(popperIndex);
        const candidateOptions=candidate.locator(optionSelector);
        const visibleCount=await candidateOptions.evaluateAll((nodes)=>nodes.filter((node)=>node.getClientRects().length&&getComputedStyle(node).visibility!=="hidden").length);
        if(visibleCount){optionLocator=candidateOptions;optionCount=visibleCount;break;}
      }
    }
    const options = await optionLocator.evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden").map((node) => ({ text: node.innerText?.trim() ?? node.textContent?.trim() ?? "", title: node.getAttribute("title"), ariaLabel: node.getAttribute("aria-label"), dataValue: node.getAttribute("data-value"), className: typeof node.className === "string" ? node.className : "", html: node.outerHTML.slice(0,500), selected: node.classList.contains("is-selected") || node.classList.contains("active") || node.getAttribute("aria-selected") === "true", disabled: node.classList.contains("is-disabled") || node.getAttribute("aria-disabled") === "true" })));
    const visibleLeaves=optionCount?[]:await popper.locator("*").evaluateAll((nodes)=>nodes.filter((node)=>node.children.length===0&&node.getClientRects().length&&getComputedStyle(node).visibility!=="hidden"&&node.textContent?.trim()).map((node)=>({text:node.textContent.trim(),className:typeof node.className==="string"?node.className:"",role:node.getAttribute("role"),tabindex:node.getAttribute("tabindex")})).slice(0,40)).catch(()=>[]);
    rows.push({ setting: title, trigger: { id: triggerId, ariaControls: controlledId, className: triggerClass, ariaExpanded }, menu: await popper.getAttribute("class").catch(()=>""), menuText:await popper.innerText().catch(()=>""), openedNew, controlledVisible, optionCount, options, visibleLeaves, panelHtml:isConversion?await popper.evaluate((node)=>node.outerHTML.slice(0,3000)).catch(()=>""):undefined });
    await editorFrame.page().keyboard.press("Escape").catch(() => undefined);
  }
  return rows;
}

async function exerciseDiscoveredSettings({ type, marker, controls, editorFrame, content, target }) {
  const settings=[];
  const titles=[...new Set(controls.map((item)=>normalizeControlTitle(item.title)).filter(Boolean).map((title)=>title==="图片对齐"&&!type.startsWith("代码块")?"文本对齐":title))];
  const active=titles.filter((title)=>!actionTitles.has(title)).sort((a,b)=>{
    const priority=(title)=>title==="清除格式"?10:title==="转换为"?11:0;
    return priority(a)-priority(b);
  });
  if(active.length===0)return [{setting:"工具栏设置项",status:"unverified",reason:"代表节点工具栏没有可验证的格式设置项"},...titles.filter((title)=>actionTitles.has(title)).map((setting)=>({setting,status:"action",reason:"节点操作项，不属于样式设置项"}))];
  const tableSettings=new Set(["表格对齐","表格铺满内容区","列宽最小值","表格边框颜色"]);
  if(type==="表格单元格"||type==="表格表头") {
    const requested=active.filter((title)=>tableSettings.has(title));
    if(requested.length) {
      try {
        const table=target.locator("xpath=ancestor::table");
        const tableResults=await applyTableSettings({table,activation:target,controls:controls.filter((c)=>tableSettings.has(normalizeControlTitle(c.title))),editorFrame});
        settings.push(...tableResults);
      } catch(error) { settings.push(...requested.map((setting)=>({setting,status:"unverified",reason:`表格单元格专属流程未能执行：${String(error?.message??error)}`}))); }
    }
  }
  for(const title of active) {
    if((type==="表格单元格"||type==="表格表头")&&tableSettings.has(title))continue;
    if(!knownSettings.has(title)) { settings.push({setting:title,status:"unverified",reason:"检测到该设置控件，但还没有对应的验证处理器"}); continue; }
    if(["表格对齐","表格铺满内容区","列宽最小值","表格边框颜色","图片样式","分割线颜色","分割线粗细"].includes(title)) {
      settings.push({setting:title,status:"unverified",reason:"该类型设置项需使用专属验证流程，当前节点流程没有处理器"}); continue;
    }
    try { settings.push(await applyTextSetting({type,title,marker,editorFrame,content})); }
    catch(error) { settings.push({setting:title,status:"failed",reason:String(error?.message??error)}); }
  }
  for(const title of actionTitles) if(titles.includes(title)) settings.push({setting:title,status:"action",reason:"节点操作项，不属于样式设置项"});
  return settings;
}

async function inspectSpecial({ type, selector, content, editorFrame }) {
  const node=content.locator(selector).first(); if(!(await node.count()))return null;
  await node.evaluate((el)=>el.scrollIntoView({block:"center",inline:"nearest"})).catch(()=>undefined);
  const activation=type==="图片"?node.locator("xpath=ancestor::figure[1]"):type==="表格属性"?node.locator("td,th").first():node;
  await activation.click({force:true,timeout:5_000}).catch(()=>undefined); await editorFrame.page().waitForTimeout(250);
  const controls=await visibleSpecialControls(editorFrame);const panels={};
  if(type==="表格属性") {
    for(const title of ["表格对齐","表格铺满内容区","列宽最小值","表格边框颜色"]) {
      await activation.click({force:true}).catch(()=>undefined);
      const control=editorFrame.locator(`[title*="${title}"]`).last();if(!(await control.count()))continue;
      await control.click({force:true}).catch(()=>undefined);await editorFrame.page().waitForTimeout(120);
      panels[title]=await editorFrame.locator(".el-popper:visible,[role=menu]:visible").evaluateAll((nodes)=>nodes.map((el)=>({text:el.innerText?.trim(),html:el.outerHTML.slice(0,4000),inputs:[...el.querySelectorAll("input")].map((x)=>({type:x.type,value:x.value,placeholder:x.placeholder,aria:x.getAttribute("aria-label"),parent:x.parentElement?.parentElement?.innerText?.trim()}))})));
      await editorFrame.page().keyboard.press("Escape").catch(()=>undefined);await editorFrame.page().waitForTimeout(80);
    }
    await activation.click({force:true}).catch(()=>undefined);await editorFrame.page().waitForTimeout(80);
  }
  if(type==="图片") {
    for(const title of ["图片对齐","图片样式"]) {
      await activation.click({force:true}).catch(()=>undefined);
      const control=editorFrame.locator(`[title*="${title}"]`).last();if(!(await control.count()))continue;
      await control.click({force:true}).catch(()=>undefined);await editorFrame.page().waitForTimeout(150);
      const inspectPanel=async()=>editorFrame.locator(".image-style-dropdown-popper:visible").last().evaluate((el)=>({text:el.innerText?.trim(),html:el.outerHTML.slice(0,9000),inputs:[...el.querySelectorAll("input,textarea")].map((x)=>({tag:x.tagName,type:x.type,value:x.value,placeholder:x.placeholder,aria:x.getAttribute("aria-label"),parent:x.parentElement?.parentElement?.innerText?.trim()})),buttons:[...el.querySelectorAll("button")].map((x)=>({title:x.title,text:x.innerText?.trim(),className:x.className}))})).catch(()=>null);
      if(title==="图片样式") {
        panels[title]={settings:await inspectPanel()};
        const styleTab=editorFrame.locator(".image-style-dropdown-popper:visible .style-tab").filter({hasText:"样式"}).last();
        if(await styleTab.count()){await styleTab.click({force:true});await editorFrame.page().waitForTimeout(100);panels[title].style=await inspectPanel();}
      } else panels[title]=await editorFrame.locator(".el-popper:visible,[role=menu]:visible").evaluateAll((nodes)=>nodes.map((el)=>el.innerText?.trim()));
      await editorFrame.page().keyboard.press("Escape").catch(()=>undefined);await editorFrame.page().waitForTimeout(100);
    }
    await activation.click({force:true}).catch(()=>undefined);await editorFrame.page().waitForTimeout(100);
  }
  return {node,activation,controls,panels};
}

async function applyImageSettings({image,activation,controls,editorFrame}) {
  const results=[];const figure=activation;
  await figure.scrollIntoViewIfNeeded().catch(()=>undefined);
  const clickControl=async(title)=>{
    await figure.click({force:true}).catch(()=>undefined);
    const button=editorFrame.locator(`.bubble-toolbar:visible [title="${title}"],.tb-group[title="${title}"]:visible,.tb-btn[title="${title}"]:visible`).last();
    if(!(await button.count()))throw new Error(`图片工具栏缺少 ${title}`);
    await button.click({force:true});await editorFrame.page().waitForTimeout(150);return button;
  };
  const before=await image.evaluate((el)=>({alt:el.getAttribute("alt"),title:el.getAttribute("title"),width:el.getAttribute("width"),height:el.getAttribute("height"),figure:el.closest("figure")?.outerHTML??""}));
  if(controls.some((c)=>normalizeControlTitle(c.title)==="图片对齐")) {
    try {
      await clickControl("图片对齐");
      const option=editorFrame.locator(".el-popper:visible .el-dropdown-menu__item").filter({hasText:"居中"}).last();
      await option.click({force:true});await editorFrame.page().waitForTimeout(200);
      const after=await figure.getAttribute("data-align");results.push({setting:"图片对齐",status:after==="center"?"passed":"failed",before:"left",after,expected:"center"});
    } catch(error){results.push({setting:"图片对齐",status:"failed",reason:String(error?.message??error)});}
  }
  if(controls.some((c)=>normalizeControlTitle(c.title)==="图片链接")) {
    try {
      await clickControl("图片链接");const input=editorFrame.locator(".link-input:visible").last();
      const expected=`https://example.com/pw-check/image-${runId}`;await input.fill(expected);
      const save=editorFrame.locator(".link-panel .save-btn:visible").last();if(await save.count())await save.click();else await input.press("Enter");
      await editorFrame.page().waitForTimeout(200);
      const after=await figure.evaluate((el)=>el.querySelector("a[href]")?.getAttribute("href")??el.closest("a[href]")?.getAttribute("href")??null);
      results.push({setting:"图片链接",status:after===expected?"passed":"failed",before:null,after,expected});
    } catch(error){results.push({setting:"图片链接",status:"failed",reason:String(error?.message??error)});}
  }
  if(controls.some((c)=>normalizeControlTitle(c.title)==="图片样式")) {
    try {
      const openPanel=async(tab)=>{
        let live=editorFrame.locator(".image-style-dropdown-popper:visible").last();
        if(!(await live.count())){await clickControl("图片样式");live=editorFrame.locator(".image-style-dropdown-popper:visible").last();}
        await live.waitFor({state:"visible",timeout:3_000});
        await live.locator(".style-tab").filter({hasText:tab}).last().click({force:true});await editorFrame.page().waitForTimeout(120);
        return live;
      };
      let panel=await openPanel("设置");
      const expectedAlt=`PW-${runId}-alt`;const expectedTitle=`PW-${runId}-title`;
      let alt=panel.locator('input[placeholder="输入图片alt属性"]');await alt.fill(expectedAlt);await alt.press("Tab");await editorFrame.page().waitForTimeout(300);
      let imageMeta=await image.evaluate((el)=>({alt:el.getAttribute("alt"),title:el.getAttribute("title")}));
      results.push({setting:"图片样式.alt属性",status:imageMeta.alt===expectedAlt?"passed":"failed",expected:expectedAlt,actual:imageMeta.alt});
      panel=await openPanel("设置");let titleInput=panel.locator('textarea[placeholder="输入图片title属性"]');await titleInput.fill(expectedTitle);await titleInput.press("Tab");await editorFrame.page().waitForTimeout(300);
      imageMeta=await image.evaluate((el)=>({alt:el.getAttribute("alt"),title:el.getAttribute("title")}));
      results.push({setting:"图片样式.title属性",status:imageMeta.title===expectedTitle?"passed":"failed",expected:expectedTitle,actual:imageMeta.title});
      try {
        panel=await openPanel("设置");
        const ratio=panel.locator(".el-select__wrapper").last();await ratio.click({force:true});
        const wide=editorFrame.locator(".image-style-select-popper .el-select-dropdown__item").filter({hasText:"宽屏(16:9)"}).last();
        if(await wide.count())await wide.evaluate((el)=>{el.scrollIntoView({block:"center"});el.click();});
        await editorFrame.page().waitForTimeout(200);
        const ratioValue=await editorFrame.locator(".image-style-dropdown-popper:visible .el-select__selected-item").last().innerText().catch(()=>"");
        const ratioStyle=await image.getAttribute("style");
        results.push({setting:"图片样式.纵横比",status:ratioValue.includes("宽屏")||ratioStyle?.includes("16 / 9")?"passed":"failed",expected:"宽屏(16:9)",actual:ratioValue,style:ratioStyle});
      } catch(error){results.push({setting:"图片样式.纵横比",status:"failed",reason:String(error?.message??error)});}
      panel=await openPanel("设置");
      let sizeInputs=panel.locator(".image-size-input");
      if(await sizeInputs.count()>=2){const lock=panel.locator(".image-size-lock-btn.locked");if(await lock.count())await lock.click({force:true});await sizeInputs.nth(0).fill("240");await sizeInputs.nth(0).press("Tab").catch(()=>undefined);await editorFrame.page().waitForTimeout(100);panel=await openPanel("设置");sizeInputs=panel.locator(".image-size-input");if(await sizeInputs.count()>=2){await sizeInputs.nth(1).fill("135");await sizeInputs.nth(1).press("Tab").catch(()=>undefined);}await editorFrame.page().waitForTimeout(250);}
      panel=await openPanel("设置");sizeInputs=panel.locator(".image-size-input");
      const dimensions=await image.evaluate((el)=>({width:el.getAttribute("width"),height:el.getAttribute("height"),style:el.getAttribute("style"),computed:{width:getComputedStyle(el).width,height:getComputedStyle(el).height},figureStyle:el.closest("figure")?.getAttribute("style")}));
      const inputDimensions=await sizeInputs.evaluateAll((els)=>els.map((el)=>el.value));
      const dimensionPassed=inputDimensions[0]==="240"&&inputDimensions[1]==="135"&&((dimensions.width==="240"&&dimensions.height==="135")||dimensions.computed.width==="240px"&&dimensions.computed.height==="135px");
      results.push({setting:"图片样式.图片尺寸",status:dimensionPassed?"passed":"failed",expected:{width:240,height:135},actual:dimensions,inputValues:inputDimensions});
      panel=await openPanel("样式");
      const activeTab=await panel.locator(".style-tab.active").innerText().catch(()=>"");
      const round=panel.locator(".style-toggle-btn:visible").filter({hasText:"圆角"}).last();await round.click({force:true});await editorFrame.page().waitForTimeout(150);
      const roundState=await round.evaluate((el)=>({active:el.classList.contains("active"),className:el.className}));
      results.push({setting:"图片样式.圆角",status:roundState.active&&activeTab.includes("样式")?"passed":"failed",actual:roundState,activeTab});
      const sliders=panel.locator(".style-slider-wrapper");
      if(await sliders.count()>=2) {
        for(let i=0;i<2;i+=1){const box=await sliders.nth(i).boundingBox();if(box)await sliders.nth(i).click({position:{x:Math.max(2,box.width*0.65),y:box.height/2},force:true});}
        const values=await panel.locator(".style-value").allInnerTexts();
        results.push({setting:"图片样式.边框/圆角粗细",status:values.some((v)=>!/0\s*px/u.test(v))?"passed":"failed",actual:values});
      } else results.push({setting:"图片样式.边框/圆角粗细",status:"failed",reason:"样式面板中没有可交互的粗细/圆角滑块"});
      const border=panel.locator('[title="选择边框颜色"]').last();
      if(await border.count()) {
        await border.click({force:true});await editorFrame.page().waitForTimeout(100);
        const hex=editorFrame.locator(".image-border-color-popper:visible .color-hex-value input:visible").last();
        if(await hex.count()){await hex.fill("E05A47");await hex.press("Enter");await editorFrame.page().waitForTimeout(180);}
        const borderHtml=await figure.innerHTML();results.push({setting:"图片样式.边框颜色",status:borderHtml.toLowerCase().includes("e05a47")?"passed":"failed",expected:"#E05A47",after:borderHtml.slice(0,800)});
      }
      await editorFrame.page().keyboard.press("Escape").catch(()=>undefined);
    } catch(error){results.push({setting:"图片样式",status:"failed",reason:String(error?.message??error)});}
  }
  return results;
}

async function tableState(table) {
  return table.evaluate((el)=>({html:el.outerHTML,cols:[...el.querySelectorAll("col")].map((c)=>c.getAttribute("style")),ancestors:(()=>{const out=[];for(let n=el;n&&out.length<4;n=n.parentElement)out.push({tag:n.tagName.toLowerCase(),style:n.getAttribute("style"),align:n.getAttribute("data-align"),textAlign:getComputedStyle(n).textAlign});return out;})()}));
}

async function applyTableSettings({table,activation,controls,editorFrame}) {
  const results=[];const present=new Set(controls.map((c)=>normalizeControlTitle(c.title)));
  const run=async(title,fn)=>{if(!present.has(title))return;try{results.push(await fn());}catch(error){results.push({setting:title,status:"failed",reason:String(error?.message??error)});}};
  const open=async(title)=>{await activation.scrollIntoViewIfNeeded().catch(()=>undefined);await activation.click({force:true}).catch(()=>undefined);const c=editorFrame.locator(`.bubble-toolbar:visible [title*="${title}"],.tb-group[title*="${title}"]:visible,.tb-btn[title*="${title}"]:visible`).last();if(!(await c.count()))throw new Error(`工具栏缺少 ${title}`);await c.click({force:true});await editorFrame.page().waitForTimeout(140);return c;};
  await run("表格对齐",async()=>{const before=await tableState(table);await open("表格对齐");const option=editorFrame.locator(".el-popper:visible .el-dropdown-menu__item").filter({hasText:"居中"}).last();await option.click({force:true});await editorFrame.page().waitForTimeout(120);const after=await tableState(table);return {setting:"表格对齐",status:JSON.stringify(before.ancestors)!==JSON.stringify(after.ancestors)?"passed":"failed",before:before.ancestors,after:after.ancestors};});
  await run("表格铺满内容区",async()=>{const before=await tableState(table);await open("表格铺满内容区");await editorFrame.page().waitForTimeout(180);const after=await tableState(table);const changed=JSON.stringify(before)!==JSON.stringify(after);return {setting:"表格铺满内容区",status:changed?"passed":"failed",before:before.html.slice(0,500),after:after.html.slice(0,500)};});
  await run("列宽最小值",async()=>{await open("列宽最小值");const panel=editorFrame.locator(".min-width-setting-content:visible").last();const inputs=panel.locator("input[type=number]");const count=await inputs.count();const disabled=[];for(let i=0;i<count;i+=1)disabled.push(await inputs.nth(i).isDisabled());if(count<2||disabled.some(Boolean))return {setting:"列宽最小值",status:"blocked",reason:"编辑器禁用了最小列宽输入；先关闭表格铺满模式再单独验证该依赖设置",inputCount:count,disabled,panelText:await panel.innerText().catch(()=>"")};await inputs.nth(0).fill("320");await inputs.nth(1).fill("180");await inputs.nth(1).press("Tab");await editorFrame.page().waitForTimeout(180);const after=await tableState(table);const styles=after.ancestors.map((a)=>a.style??"").join(" ");const matched=styles.includes("320px")&&styles.includes("180px")||after.cols.some((v)=>v?.includes("320px"))&&after.cols.some((v)=>v?.includes("180px"));return {setting:"列宽最小值",status:matched?"passed":"failed",after:{cols:after.cols,ancestors:after.ancestors},expected:[320,180],reason:matched?undefined:"输入值未反映到表格节点或最小列宽样式"};});
  await run("表格边框颜色",async()=>{const before=await tableState(table);await open("表格边框颜色");const hex=editorFrame.locator(".text-color-picker-popper:visible .color-hex-value input:visible").last();if(!(await hex.count()))return {setting:"表格边框颜色",status:"failed",reason:"HEX 输入框未出现"};await hex.fill("E05A47");await hex.press("Enter");await editorFrame.page().waitForTimeout(220);const after=await tableState(table);const changed=after.html.toLowerCase().includes("e05a47")||after.html.includes("rgb(224, 90, 71)");return {setting:"表格边框颜色",status:changed?"passed":"failed",before:before.html.slice(0,500),after:after.html.slice(0,1000),expected:"#E05A47"};});
  return results;
}

async function applyDividerSettings({divider,controls,editorFrame}) {
  const results=[];const titles=new Set(controls.map((c)=>normalizeControlTitle(c.title)));
  const read=()=>divider.evaluate((el)=>({html:el.outerHTML,style:el.querySelector(".qc-divider")?.getAttribute("style")??""}));
  if(titles.has("分割线颜色")) {
    try{const before=await read();await divider.click({force:true});const c=editorFrame.locator('.bubble-toolbar [title*="分割线颜色"],.tb-group[title*="分割线颜色"]').last();await c.click({force:true});await editorFrame.page().waitForTimeout(100);const input=editorFrame.locator(".text-color-picker-popper:visible .color-hex-value input:visible").last();if(!(await input.count()))throw new Error("分割线颜色 HEX 输入框未出现");await input.fill("E05A47");await input.press("Enter");await editorFrame.page().waitForTimeout(180);const after=await read();results.push({setting:"分割线颜色",status:after.html.toLowerCase().includes("e05a47")||after.html.includes("rgb(224, 90, 71)")?"passed":"failed",before,after,expected:"#E05A47"});}catch(error){results.push({setting:"分割线颜色",status:"failed",reason:String(error?.message??error)});}
  }
  if(titles.has("分割线粗细")) {
    try{const before=await read();await divider.click({force:true});const c=editorFrame.locator('.bubble-toolbar [title*="分割线粗细"],.tb-group[title*="分割线粗细"]').last();await c.click({force:true});await editorFrame.page().waitForTimeout(100);const popper=editorFrame.locator(".el-popper:visible").last();const options=popper.locator("[role=option],.el-dropdown-menu__item,button");const count=await options.count();if(!count)throw new Error(`粗细设置没有选项：${await popper.innerText().catch(()=>"")}`);await options.last().click({force:true});await editorFrame.page().waitForTimeout(150);const after=await read();results.push({setting:"分割线粗细",status:before.style!==after.style?"passed":"failed",before,after,reason:before.style!==after.style?undefined:"粗细选择后分隔线样式未变化"});}catch(error){results.push({setting:"分割线粗细",status:"failed",reason:String(error?.message??error)});}
  }
  return results;
}

async function saveProduct(productFrame, adminPage) {
  await productFrame.getByRole("link", { name: "保存", exact: true }).click();
  const duplicate = productFrame.getByText(/Title.*已有产品相同.*确认提交/u);
  await duplicate.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
  if (await duplicate.isVisible().catch(() => false)) {
    const dialog = duplicate.locator('xpath=ancestor::div[contains(@class,"popBox")][1]');
    const confirm = dialog.getByText("确定", { exact: true });
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    else await productFrame.getByText("确定", { exact: true }).last().click();
  }
  const frames = () => adminPage.frames();
  let success = null;
  let visibleText = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    for (const frame of frames()) {
      const bodyText = await frame.locator("body").innerText().catch(() => "");
      const links = await frame.locator("a[href]").evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden").map((node) => ({ href: node.href, text: node.innerText?.trim() ?? "" }))).catch(() => []);
      const publicLink = links.find((link) => {
        try { return new URL(link.href).origin === new URL(baseUrl).origin; } catch { return false; }
      });
      if (/产品保存成功|保存成功/u.test(bodyText) && publicLink) {
        success = { url: publicLink.href, text: bodyText };
        break;
      }
      if (bodyText.includes("保存成功")) visibleText = bodyText.slice(-1_000);
    }
    if (success) break;
    await adminPage.waitForTimeout(250);
  }
  if (!success) {
    await adminPage.screenshot({ path: path.join(runDir, "后台-保存确认异常.png"), fullPage: true }).catch(() => undefined);
    throw new Error(`保存后没有找到可见成功提示和目标站点链接；可见文本摘要=${visibleText}`);
  }
  assert(new URL(success.url).origin === new URL(baseUrl).origin, `成功提示链接不属于目标站点：${success.url}`);
  await adminPage.screenshot({ path: path.join(runDir, "后台-保存成功.png") });
  return success;
}

async function readMarkers(root, markers) {
  return root.evaluate((element, list) => list.map((marker) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) if (textNode.textContent?.includes(marker)) break;
    if (!textNode) return { marker, found: false };
    const node = textNode.parentElement;
    const style = getComputedStyle(node);
    const block = node.closest("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th,figure") ?? node;
    const blockStyle = getComputedStyle(block);
    const marks = [];
    const decorations = new Set();
    let backgroundColor = "rgba(0, 0, 0, 0)";
    for (let current = node; current && current !== element; current = current.parentElement) {
      const currentStyle = getComputedStyle(current);
      if (["STRONG","B","EM","I","U","S","DEL","STRIKE","CODE"].includes(current.tagName)) marks.push(current.tagName.toLowerCase());
      for (const decoration of currentStyle.textDecorationLine.split(/\s+/u)) if (decoration && decoration !== "none") decorations.add(decoration);
      if (backgroundColor === "rgba(0, 0, 0, 0)" && currentStyle.backgroundColor !== "rgba(0, 0, 0, 0)" && currentStyle.backgroundColor !== "transparent") backgroundColor = currentStyle.backgroundColor;
    }
    const path = [];
    for (let current = node; current && current !== element.parentElement && path.length < 8; current = current.parentElement) {
      path.push(current.tagName.toLowerCase());
      if (current === element) break;
    }
    return { marker, found: true, path, marks: [...new Set(marks)], inline: { fontFamily: style.fontFamily, fontWeight: style.fontWeight, fontStyle: style.fontStyle, fontSize: style.fontSize, color: style.color, textDecoration: [...decorations].join(" ") || "none", backgroundColor }, block: { tag: block.tagName.toLowerCase(), lineHeight: blockStyle.lineHeight, textAlign: blockStyle.textAlign }, href: node.closest("a[href]")?.getAttribute("href") ?? null };
  }), markers);
}

async function captureMarkerStates(content, markers) {
  const states = {};
  for (const marker of markers) states[marker] = await markerState(content, marker);
  return states;
}

function compareMarkerStates(backend, frontend) {
  const keys = ["fontFamily", "fontWeight", "fontStyle", "fontSize", "color", "backgroundColor", "textDecoration"];
  return Object.keys(backend).map((marker) => {
    const expected = backend[marker]; const actual = frontend[marker];
    if (!expected?.found || !actual?.found) return { marker, status: "failed", reason: "后台或前台缺少该代表标记", backendFound: Boolean(expected?.found), frontendFound: Boolean(actual?.found) };
    const differences = {};
    for (const key of keys) if (expected.inline?.[key] !== actual.inline?.[key]) differences[`inline.${key}`] = { backend: expected.inline?.[key], frontend: actual.inline?.[key] };
    if (JSON.stringify(expected.marks ?? []) !== JSON.stringify(actual.marks ?? [])) differences.marks = { backend: expected.marks ?? [], frontend: actual.marks ?? [] };
    for (const key of ["tag", "lineHeight", "textAlign"]) if (expected.block?.[key] !== actual.block?.[key]) differences[`block.${key}`] = { backend: expected.block?.[key], frontend: actual.block?.[key] };
    if (expected.href !== actual.href) differences.href = { backend: expected.href, frontend: actual.href };
    return { marker, status: Object.keys(differences).length ? "failed" : "passed", differences };
  });
}

async function main() {
  await fs.mkdir(runDir,{recursive:true});
  const account=process.env.UI_ADMIN_ACCOUNT;const password=process.env.UI_ADMIN_PASSWORD;
  const configPath=process.env.UI_ADMIN_CONFIG??process.env.BUG1004949_ADMIN_CONFIG;
  const config=configPath?JSON.parse(await fs.readFile(path.resolve(configPath),"utf8")):{};
  const credentials={account:account??config.account??config.username??config.loginName,password:password??config.password};
  assert(credentials.account&&credentials.password,"请通过 UI_ADMIN_CONFIG 或运行环境提供管理员凭据");
  assert(!focusSetting||focusType,"使用 --setting 时同时指定 --type，避免对其他类型进行无关修改");
  const report={run_id:runId,site_url:baseUrl,product_name:productName,mode:saveBatch?"save-batch":inspectOptions?"option-inventory":scanOnly?"scan":focusSetting?"setting-diagnostic":focusType?"type-diagnostic":"full",status:"running",saved:false,checks:[],setting_checks:[],setting_options:[],not_present_types:[],unsupported_types:[],blocked_types:[],failed_types:[]};
  const profileDir=path.resolve(process.env.UI_PROFILE_DIR??path.join(outputRoot,"browser-profile"));
  await fs.mkdir(profileDir,{recursive:true});
  const context=await chromium.launchPersistentContext(profileDir,{headless,locale:"zh-CN",...(proxyServer?{proxy:{server:proxyServer}}:{})});
  context.setDefaultTimeout(5_000);let adminPage;let saved=false;let traceStarted=false;
  try {
    const admin=await openProduct(context,credentials);adminPage=admin.adminPage;const productFrame=admin.productFrame;
    if(!scanOnly&&focusType) { await context.tracing.start({screenshots:false,snapshots:true,sources:false});traceStarted=true; }
    const originalHtml=await productFrame.locator('textarea[name="productText.prodDescript"]').first().inputValue();
    assert(originalHtml.length>20,"产品描述 HTML 为空");await fs.writeFile(path.join(runDir,"description-original.html"),originalHtml);
    const {editorFrame,wrapperFrame,content}=await getEditor(productFrame,adminPage);
    const editorOriginal=await content.innerHTML();await fs.writeFile(path.join(runDir,"description-editor-original.html"),editorOriginal);
    const baselineText=await content.innerText();report.baseline_text_length=baselineText.length;
    report.detected_node_types=await detectNodeTypes(content);report.type_samples=await buildTypeSamples(content);
    report.editor_baseline_length=editorOriginal.length;
    report.baseline_structure=await describeContentStructure(content);
    await fs.writeFile(path.join(runDir,"description-structure-original.json"),`${JSON.stringify(report.baseline_structure,null,2)}\n`);
    await adminPage.screenshot({path:path.join(runDir,"后台-编辑前.png")});
    if(scanOnly) {
      const discovered=new Set(report.type_samples.map((sample)=>sample.type));
      if(report.detected_node_types.tables.tables)discovered.add("表格属性");
      if(report.detected_node_types.images)discovered.add("图片");
      if(report.detected_node_types.dividers)discovered.add("分隔线");
      if(report.detected_node_types.math)discovered.add("MathML 公式");
      const expected=[...Array.from({length:6},(_,index)=>`标题 H${index+1}`),"普通段落","加粗文本","斜体文本","下划线文本","删除线文本","行内代码","链接文本","无序列表","嵌套列表","有序列表","任务列表","引用","嵌套引用","无语言代码块","Emoji 文本","表格单元格","表格表头","表格属性","图片","分隔线","MathML 公式"];
      const allTypes=[...new Set([...expected,...discovered])];
      report.type_inventory=allTypes.map((type)=>({type,status:discovered.has(type)?"present":"not_present",sample:report.type_samples.find((sample)=>sample.type===type)}));
      for(const type of allTypes.filter((item)=>!discovered.has(item)))report.not_present_types.push({type,status:"not_present",reason:"当前产品描述中没有可识别节点"});
      report.status="scanned";
      await adminPage.screenshot({path:path.join(runDir,"诊断-类型清单.png")});
      return;
    }
    const markerByType=new Map();
    const specialTypes=["表格属性","图片","分隔线","MathML 公式"];
    assert(!inspectOptions||(focusType&&!specialTypes.includes(focusType)),"--inspect-options 目前用于单个文本类型");
    assert(!saveBatch||focusSetting!=="转换为","转换选项目前只做逐项应用与结构恢复诊断，不能用单次保存批次证明每个选项的前后台持久化");
    let samples=focusType?report.type_samples.filter((x)=>x.type===focusType):report.type_samples;
    if(focusSetting) samples=samples.filter((sample)=>!focusType||sample.type===focusType);
    assert(!saveBatch||(focusType&&focusSetting&&!specialTypes.includes(focusType)&&!scanOnly),"--save-batch 目前要求指定一个文本类型和一个设置项；特殊节点需先通过专属保存断言");
    if(focusType&&!samples.length&&!specialTypes.includes(focusType)) {
      report.status="not_present";report.not_present_types.push({type:focusType,status:"not_present",reason:"当前描述未识别到此类型"});return;
    }
    for(let index=0;index<samples.length;index+=1) {
      const sample=samples[index];const {type,fingerprint}=sample;let target;let locatorResolution;
      const marker=saveBatch?batchMarkerFor(type,fingerprint,""):`⟦${markerPrefix}-${String(index+1).padStart(2,"0")}⟧`;
      try {
        locatorResolution=await locateSample(content,sample);target=locatorResolution.target;
        assert(target,`代表节点定位存在歧义或内容已变化：${JSON.stringify({fingerprint,locatorResolution})}`);
        const existingLegacyMarker=batchMarkerFor(type,fingerprint,await target.innerText());
        const effectiveMarker=saveBatch?existingLegacyMarker:marker;
        if(!(await target.innerText()).includes(effectiveMarker)){const isCode=type.startsWith("代码块");await insertMarker({target,content,editorFrame,marker:effectiveMarker,code:isCode});}
        const activeMarker=effectiveMarker;
        const settingIntegrityBefore=saveBatch?await contentIntegritySnapshot(content,target,activeMarker,focusSetting):null;
        await target.scrollIntoViewIfNeeded();
        await target.click({force:true});
        const selected=await selectMarker(content,activeMarker);const controls=selected?await visibleBubbleControls(editorFrame):[];
        if(inspectOptions&&selected){report.setting_options.push({type,marker:activeMarker,options:await inspectBubbleOptions({type,marker:activeMarker,controls,editorFrame,content,target})});markerByType.set(type,activeMarker);continue;}
        let applicableControls=controls;
        if(focusSetting) applicableControls=controls.filter((control)=>{
          const title=normalizeControlTitle(control.title);
          const canonical=title==="图片对齐"&&!type.startsWith("代码块")?"文本对齐":title;
          return canonical.includes(focusSetting);
        });
        const settings=selected?await exerciseDiscoveredSettings({type,marker:activeMarker,controls:applicableControls,editorFrame,content,target}):[{setting:"工具栏选择",status:"blocked",reason:"无法选择插入的唯一标记"}];
        if(saveBatch) {
          const settingIntegrityAfter=await contentIntegritySnapshot(content,target,activeMarker,focusSetting);
          const integrity=compareIntegritySnapshots(settingIntegrityBefore,settingIntegrityAfter);
          report.setting_integrity={before:settingIntegrityBefore,after:settingIntegrityAfter,...integrity};
          if(!integrity.matches)settings.push({setting:"完整性检查",status:"failed",reason:"本批造成了预期设置之外的结构或文本变化",differences:integrity.differences});
        }
        markerByType.set(type,activeMarker);report.setting_checks.push({type,controls,settings,locator_resolution:locatorResolution});
        const blocking=hasBlockingSettings(settings);
        if(blocking)report.failed_types.push(type);
        if(settings.some((setting)=>setting.status==="blocked"))report.blocked_types.push(type);
        record(report,type,blocking?(settings.some((setting)=>setting.status==="failed")?"failed":"blocked"):"passed",{marker:activeMarker,fingerprint,locator_resolution:locatorResolution,controls,settings});
      } catch(error) { report.blocked_types.push(type);report.failed_types.push(type);record(report,type,"blocked",{marker,fingerprint,locator_resolution:locatorResolution,reason:String(error?.message??error)}); }
      await editorFrame.page().keyboard.press("Escape").catch(()=>undefined);
      await editorFrame.page().waitForTimeout(500);
    }
    if(focusType&&!specialTypes.includes(focusType)&&!saveBatch) {
      report.markers=[...markerByType].map(([type,marker])=>({type,marker}));
      report.editor_markers=await readMarkers(content,[...markerByType.values()]);
      await adminPage.screenshot({path:path.join(runDir,"诊断-后台.png")});
      report.status="diagnostic";
      return;
    }
    if(report.detected_node_types.emojiCharacters===0)report.not_present_types.push({type:"Emoji 文本",status:"not_present",reason:"当前描述没有 emoji 字符"});
    for(const [type,selector] of [["表格属性","table"],["图片","img"],["分隔线",".qc-divider-wrapper"],["MathML 公式","math"]]) {
      if(focusType&&focusType!==type)continue;
      const found=await inspectSpecial({type,selector,content,editorFrame});
      if(!found){report.not_present_types.push({type,status:"not_present",reason:"当前描述没有该节点"});continue;}
      const settingNames=found.controls.map((x)=>normalizeControlTitle(x.title)).filter((x)=>x&&!actionTitles.has(x));
      if(type==="MathML 公式"&&!settingNames.some((title)=>/公式|math|latex/iu.test(title))){report.unsupported_types.push({type,status:"unsupported",reason:"公式以静态 MathML 呈现，未发现公式专属编辑入口"});record(report,type,"unsupported",{reason:"没有公式编辑入口",toolbar:found.controls});continue;}
      let settings=[];
      if(type==="表格属性")settings=await applyTableSettings({table:found.node,activation:found.activation,controls:found.controls,editorFrame});
      else if(type==="图片")settings=await applyImageSettings({image:found.node,activation:found.activation,controls:found.controls,editorFrame});
      else if(type==="分隔线")settings=await applyDividerSettings({divider:found.node,controls:found.controls,editorFrame});
      else settings=settingNames.map((setting)=>({setting,status:"failed",reason:"没有公式专属编辑器处理器"}));
      report.setting_checks.push({type,controls:found.controls,panels:found.panels,settings});
      const blocking=hasBlockingSettings(settings);
      if(blocking)report.failed_types.push(type);
      if(settings.some((setting)=>setting.status==="blocked"))report.blocked_types.push(type);
      record(report,type,blocking?(settings.some((setting)=>setting.status==="failed")?"failed":"blocked"):"passed",{controls:found.controls,settings});
    }
    if((focusType||focusSetting)&&!saveBatch) {
      report.markers=[...markerByType].map(([type,marker])=>({type,marker}));
      report.editor_markers=await readMarkers(content,[...markerByType.values()]);
      await adminPage.screenshot({path:path.join(runDir,"诊断-特殊类型.png")});
      report.status="diagnostic";
      return;
    }
    report.markers=[...markerByType].map(([type,marker])=>({type,marker}));report.editor_markers=await readMarkers(content,[...markerByType.values()]);
    await adminPage.screenshot({path:path.join(runDir,"后台-验证现场.png")});
    if(focusType&&!saveBatch){report.status="diagnostic";return;}
    assert(report.editor_markers.every((m)=>m.found),"至少一个标记未保留在编辑器中");
    const markerPattern=/⟦PW-[^⟧]+⟧/gu;
    const textAfter=await content.innerText();
    report.content_integrity={baselineTextLength:baselineText.length,afterTextLength:textAfter.length,unmarkedTextMatches:baselineText.replace(markerPattern,"")===textAfter.replace(markerPattern,"")};
    await fs.writeFile(path.join(runDir,"description-structure-before-save.json"),`${JSON.stringify(await describeContentStructure(content),null,2)}\n`);
    assert(report.content_integrity.unmarkedTextMatches,"测试编辑意外改动了原文文本或空白；本次不保存");
    assert(report.failed_types.length===0,`保存前设置未全部通过：${report.failed_types.join(", ")}`);
    assert(report.setting_checks.flatMap((g)=>g.settings).every((s)=>["passed","unsupported","action","not_applicable"].includes(s.status)),"存在未完成设置项");
    if(process.argv.includes("--no-save")) { report.status="diagnostic";return; }
    const savedResult=await saveProduct(productFrame,adminPage);saved=true;report.saved=true;report.public_url=savedResult.url;
    const backToList=productFrame.getByText("返回列表",{exact:true}).last();
    if(await backToList.isVisible().catch(()=>false))await backToList.click();
    const productLink=productFrame.getByRole("link",{name:productName,exact:true});
    await productLink.waitFor({state:"visible",timeout:30_000});
    await productLink.click();await productFrame.locator('textarea[name="productText.prodDescript"]').waitFor({state:"attached",timeout:20_000});
    const persistedField=productFrame.locator('textarea[name="productText.prodDescript"]').first();
    let persisted="";
    for(let attempt=0;attempt<100;attempt+=1){persisted=await persistedField.inputValue();if([...markerByType.values()].every((marker)=>persisted.includes(marker)))break;await adminPage.waitForTimeout(250);}
    await fs.writeFile(path.join(runDir,"description-saved.html"),persisted);
    report.backend_persisted=Object.fromEntries([...markerByType].map(([type,marker])=>[type,persisted.includes(marker)]));
    assert(Object.values(report.backend_persisted).every(Boolean),"后台重新打开后有测试修改丢失");
    const reopened=await getEditor(productFrame,adminPage);
    const persistedText=await reopened.content.innerText();
    report.backend_integrity={unmarkedTextMatches:baselineText.replace(markerPattern,"")===persistedText.replace(markerPattern,"")};
    assert(report.backend_integrity.unmarkedTextMatches,"重新打开后台后原文或代码空白发生变化");
    const backendStates=await captureMarkerStates(reopened.content,[...markerByType.values()]);
    report.backend_marker_states=backendStates;
    await gotoWithRetry(adminPage,savedResult.url);await adminPage.waitForTimeout(1_500);
    const tab=adminPage.locator(".detial-cont-tabslabel a").filter({hasText:"Product Description"}).first();if(await tab.isVisible().catch(()=>false))await tab.click();
    const frontRoot=adminPage.locator(".detial-cont-prodescription");report.frontend_markers=await readMarkers(frontRoot,[...markerByType.values()]);
    assert(report.frontend_markers.every((m)=>m.found),"前台详情页未显示全部测试修改");
    const frontendStates=await captureMarkerStates(frontRoot,[...markerByType.values()]);
    report.frontend_style_parity=compareMarkerStates(backendStates,frontendStates);
    assert(report.frontend_style_parity.every((item)=>item.status==="passed"),"前后台内容样式存在差异；详见 frontend_style_parity");
    await adminPage.screenshot({path:path.join(runDir,"前台-产品详情.png"),fullPage:true});report.status="passed";
  } catch(error) {
    report.status="failed";report.error=String(error?.stack??error);if(adminPage)await adminPage.screenshot({path:path.join(runDir,"失败现场.png")}).catch(()=>undefined);throw error;
  } finally {
    report.saved=saved;report.finished_at=new Date().toISOString();
    const statuses=report.setting_checks.flatMap((group)=>group.settings??[]).map((item)=>item.status);
    report.outcome_counts=Object.fromEntries(["passed","failed","blocked","unverified","unsupported","not_applicable","action"].map((status)=>[status,statuses.filter((value)=>value===status).length]));
    report.type_counts={present:report.type_inventory?.filter((item)=>item.status==="present").length??report.type_samples?.length??0,not_present:report.not_present_types.length};
    await fs.writeFile(path.join(runDir,"result.json"),`${JSON.stringify(report,null,2)}\n`);
    if(traceStarted) await context.tracing.stop({path:path.join(runDir,"playwright-trace.zip")}).catch(()=>undefined);
    await context.close().catch(()=>undefined);console.log(`结果：${path.join(runDir,"result.json")}`);
  }
}

async function selfTestDiscovery() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const fixtures = [
      `<h2>Heading A</h2><p>Plain paragraph A</p><blockquote><p>Quote A</p><blockquote><p>Nested quote</p></blockquote></blockquote><ul><li><p>List A</p><ul><li><p>Nested item</p></li></ul></li></ul><pre><code>plain code</code></pre><pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre><table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell A</td></tr></tbody></table><table><tr><td>Cell B</td></tr></table><img alt="one"><img alt="two">`,
      `<img alt="two"><table><tr><td>Cell B</td></tr></table><pre><code class="language-mermaid">graph TD; A--&gt;B</code></pre><ul><li><p>List A</p><ul><li><p>Nested item</p></li></ul></li></ul><blockquote><p>Quote A</p><blockquote><p>Nested quote</p></blockquote></blockquote><h2>Heading A</h2><p>Plain paragraph A</p><pre><code>plain code</code></pre><table><thead><tr><th>Header</th></tr></thead><tbody><tr><td>Cell A</td></tr></tbody></table><img alt="one">`,
    ];
    const results = [];
    const discovered=[];
    for (const html of fixtures) {
      await page.setContent(`<main class="ProseMirror" contenteditable="true">${html}</main>`);
      const content = page.locator("main");
      const inventory = await detectNodeTypes(content);
      const samples = await buildTypeSamples(content);
      const types = new Set(samples.map((sample) => sample.type));
      assert(types.has("标题 H2") && types.has("普通段落") && types.has("嵌套列表") && types.has("嵌套引用"), "结构样例中的标题、段落或嵌套内容识别失败");
      assert(types.has("代码块（语言：mermaid）") && types.has("无语言代码块"), "Mermaid 或无语言代码块未识别");
      assert(inventory.tables.tables === 2 && inventory.images === 2, "多表格或多图片计数错误");
      discovered.push({samples,content});
      results.push({ sampleCount: samples.length, tableCount: inventory.tables.tables, imageCount: inventory.images, typeNames: [...types] });
    }
    assert(JSON.stringify(results[0].typeNames.slice().sort()) === JSON.stringify(results[1].typeNames.slice().sort()), "重排内容后类型识别集合发生变化");
    for(const sample of discovered[0].samples){
      const relocated=await locateSample(discovered[1].content,sample);
      assert(relocated.target,`内容重排后代表元素定位歧义：${sample.type}`);
      const relocatedText=(await relocated.target.innerText()).replace(/\s+/gu," ").trim();
      assert(createHash("sha256").update(relocatedText).digest("hex")===sample.fingerprint.textHash,`内容重排后定位到错误节点：${sample.type}`);
    }
    await page.setContent(`<main class="ProseMirror" contenteditable="true"><h1>Heading 1</h1><h2>Heading 2</h2><h3>Heading 3</h3><h4>Heading 4</h4><h5>Heading 5</h5><h6>Heading 6</h6></main>`);
    const headingSamples=await buildTypeSamples(page.locator("main"));
    const headingMarkers=headingSamples.filter((sample)=>sample.type.startsWith("标题 H")).map((sample)=>batchMarkerFor(sample.type,sample.fingerprint,""));
    assert(headingMarkers.length===6&&new Set(headingMarkers).size===6,"H1–H6 保存标记存在碰撞");
    const integrityMarker="⟦PW-INTEGRITY-FIXTURE⟧";
    await page.setContent(`<main class="ProseMirror" contenteditable="true"><ul><li><p>alpha ${integrityMarker} beta</p><ul><li><p>nested</p></li></ul></li><li><p>keep</p></li></ul><table><tbody><tr><td>cell</td></tr></tbody></table><pre><code>line one\n  line two</code></pre></main>`);
    const integrityRoot=page.locator("main");const integrityTarget=integrityRoot.locator("ul > li > p").first();
    const integrityBefore=await contentIntegritySnapshot(integrityRoot,integrityTarget,integrityMarker,"字体颜色");
    await integrityRoot.locator("p").first().evaluate((p,marker)=>{
      const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);let text;
      while((text=walker.nextNode()))if(text.textContent.includes(marker)){
        const range=document.createRange();const start=text.textContent.indexOf(marker);range.setStart(text,start);range.setEnd(text,start+marker.length);
        const strong=document.createElement("strong");strong.style.color="rgb(19, 168, 168)";range.surroundContents(strong);break;
      }
    },integrityMarker);
    const expectedChange=compareIntegritySnapshots(integrityBefore,await contentIntegritySnapshot(integrityRoot,integrityTarget,integrityMarker,"字体颜色"));
    assert(expectedChange.matches,"预期的标记行内样式变化被误判为结构破坏");
    const tamperedTarget=integrityRoot.locator("table td");await tamperedTarget.evaluate((cell)=>cell.setAttribute("data-unexpected","changed"));
    const unexpectedChange=compareIntegritySnapshots(integrityBefore,await contentIntegritySnapshot(integrityRoot,integrityTarget,integrityMarker,"字体颜色"));
    assert(!unexpectedChange.matches,"未发现非目标表格属性变化");
    console.log(JSON.stringify({ status: "passed", fixtures: results }, null, 2));
  } finally {
    await browser.close();
  }
}

const run = process.argv.includes("--self-test") ? selfTestDiscovery : main;
run().catch((error)=>{console.error(error?.stack??error);process.exitCode=1;});

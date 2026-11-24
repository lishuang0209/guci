import { artworkImageData, assetUrl, decodeArtwork, drawArtworkImage, fileData, packagingAdjustment, workspaceUrl } from './images.mjs';
import { display, mountArtwork } from './artwork.mjs';
import { hasArtworkTransparency, removeArtworkBackground, suggestArtworkBackground } from './artwork-cutout.mjs';
import { projectFormMarkup, renderProjects } from './projects.mjs';
import { catalogCards, catalogForm, catalogPicker, renderCatalog } from './catalog.mjs';

const screenGroups = [
  [['overview', '提案总览'], ['inquiry', '询盘提取'], ['product', '商品资料']],
  [['print', '印花设计'], ['scenes', '场景图片'], ['packaging', '包装审稿']],
  [['versions', '提案与版本'], ['replies', '采购回复测试']],
];
const screens = screenGroups.flat();
const labels = {
  printA: 'Print A', printB: 'Print B', packA: 'Pack A', packB: 'Pack B',
};
const packOptionLabels = { A: 'Pack A · 折叠彩盒', B: 'Pack B · 硬质礼盒' };
const proposalImageLabels = { lifestyle: '场景图片', printA: '印花 A', printB: '印花 B', packA: '包装 A', packB: '包装 B' };
const imageNames = {
  'lifestyle-kit': '酒店早餐场景图',
  'print-a-kit': '小尺寸印花',
  'print-b-kit': '大尺寸印花',
  'pack-a-kit': '鼠尾草绿折叠彩盒',
  'pack-b-kit': '森林绿硬质礼盒',
};
const revisionNames = {
  local_overlay: '调整后的贴图', local_adjustment: '颜色调整版', local_copy: '复制版',
  model_preview: 'AI 生成版', uploaded_preview: '上传版',
};
const kindNames = {
  demo_illustration: '自制演示示意图',
  ai_preview: 'AI 效果图', local_overlay: '贴图预览', local_adjustment: '配色预览', local_copy: '包装预览',
  model_preview: 'AI 效果图', uploaded_preview: '上传图片', uploaded_product_photo: '商品主图', uploaded_artwork: '印花素材',
};
const current = { print: 'A', pack: 'A', mountToken: 0, modelPrompt: null, replySummary: false, revision: {} };
const drafts = { text: undefined, reply: undefined, product: null, A: '', B: '' };
let state;
let projects;
let catalogProducts = [];
let pending = false;
let toastTimer;
let inquiryTimer;
let inquiryError = '';
let inquiryComposing = false;
let inquiryReadingFile = false;
let inquiryFileMessage = '';
let lastArtworkImport = 0;
let sceneGenerating = false;
let generatingPack = null;
const inquiryFileHint = '支持 TXT、MD、DOCX 和含文字的 PDF，单个文件最多 8 MB。';

const query = (selector, root = document) => root.querySelector(selector);
const main = query('#main');
const dialog = query('#dialog');
const escape = input => String(input ?? '').replace(/[&<>"']/g, value => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[value]);
const formatDate = iso => new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(iso));
const asset = id => state.assets.find(value => value.id === id);
const imageName = item => imageNames[item.id] ?? (item.slot === 'lifestyle' ? item.label : revisionNames[item.kind] ?? item.label);
function imageChoice(item, candidates) {
  const name = imageName(item);
  return item.createdAt && candidates.some(other => other.id !== item.id && imageName(other) === name)
    ? `${name} · ${formatDate(item.createdAt)}` : name;
}
const image = (id, classes = '') => {
  const entry = asset(id);
  return entry ? `<img class="${classes}" src="${assetUrl(entry.id)}" alt="${escape(imageName(entry))}">` : '<span class="asset-empty">未选图</span>';
};
const qtyLabel = { approximately: '约', 'around / initially': '约，首批', around: '约', initially: '首批', first: '首批' };
const labelFor = (labels, value) => Object.hasOwn(labels, value) ? labels[value] : value;
const chip = (text, variant = '') => `<span class="chip ${variant}">${escape(text)}</span>`;
const heading = (title, detail, extra = '') => `<header class="section-heading"><div><h2>${title}</h2><p>${detail}</p></div>${extra}</header>`;
const button = (text, action, extra = '', classes = 'button') => `<button class="${classes}" type="button" data-action="${action}" ${extra}>${text}</button>`;
const optionSwitch = (name, selected) => `<div class="segmented" role="group" aria-label="${name === 'print' ? '选择印花' : '选择包装'}">
  ${['A', 'B'].map(option => {
    const label = name === 'print' ? `Print ${option}` : packOptionLabels[option];
    return button(label, name + '-tab', `data-option="${option}" aria-pressed="${selected === option}"`, 'segment');
  }).join('')}
</div>`;
function route() {
  const id = screens.find(([key]) => '#' + key === location.hash)?.[0] ?? 'overview';
  return id === 'overview' && !state?.project.isDemo ? 'inquiry' : id;
}
const libraryPage = location.pathname === '/library';
const projectList = !libraryPage && !new URLSearchParams(location.search).has('project') &&
  !screens.some(([id]) => '#' + id === location.hash);
const isBlank = () => state.project.template === 'blank';
const hasProduct = () => Boolean(state.kit.product && state.selected.source);
const designPage = () => state.scenePrintMode === 'required' ||
  (state.scenePrintMode !== 'plain' && state.artworkId) ? 'print' : 'scenes';
const missingScenePrint = () => state.scenePrintMode === 'required' && !state.selected.printA && !state.selected.printB;
const factoryUrl = () => workspaceUrl('/api/factory-request');
function factoryNotice() {
  const item = state.kit.product;
  if (!item || item.factoryConfirmed) return '';
  return `<aside class="notice"><strong>生产规格待工厂确认</strong>
    <a href="${factoryUrl()}" class="text-link" download>下载工厂确认清单</a></aside>`;
}
const versionUrl = (version, inline = false) => workspaceUrl(`/api/versions/${version}/pdf${inline ? '?inline' : ''}`);
const candidateList = slot => state.assets.filter(value => value.slot === slot).sort((a, b) =>
  (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
const viewButton = id => button('查看大图', 'image', `data-id="${escape(id)}"`, 'button flat button-sm');

async function request(path, data) {
  const shared = path === '/api/projects' || path === '/api/catalog' || path.startsWith('/api/catalog/') || path === '/api/settings/model';
  const response = await fetch(shared ? path : workspaceUrl(path), data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(shared ? {} : { revision: state?.revision }), ...data }),
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || '本地操作失败。');
    error.status = response.status;
    throw error;
  }
  if (body.workspace) state = body.workspace;
  return body.result ?? body;
}

function showToast(message, error = false) {
  const toast = query('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

function mountWorkspace() {
  if (libraryPage) {
    main.innerHTML = renderCatalog();
    renderCatalogResults(main);
    return;
  }
  if (projectList) {
    main.innerHTML = renderProjects(projects);
    return;
  }
  const { name, customer, isDemo } = state.project;
  const groups = screenGroups.map(group => group.filter(([key]) => isDemo || key !== 'overview'));
  main.innerHTML = `<header class="project-header">
    <h1>${escape(name)}${isDemo ? '示例' : ''}</h1>
    ${customer ? `<p>客户 · ${escape(customer)}</p>` : ''}
  </header>
  <div class="workspace-tabs" role="tablist" aria-label="项目工作区">
    ${groups.map(group => `<div class="workspace-tab-group" role="presentation">
      ${group.map(([key, label]) => `<a class="workspace-tab" role="tab" id="tab-${key}" href="#${key}" aria-controls="workspace-panel">${label}</a>`).join('')}
    </div>`).join('')}
  </div>
  <div id="workspace-panel" role="tabpanel" tabindex="0"></div>`;
  render();
}

function revealWorkspaceTab(tab) {
  const row = tab.closest('.workspace-tabs');
  if (row.scrollWidth <= row.clientWidth) return;
  const start = row.getBoundingClientRect().left + row.clientLeft;
  const end = start + row.clientWidth;
  const { left, right } = tab.getBoundingClientRect();
  if (left < start) row.scrollLeft += left - start - 4;
  else if (right > end) row.scrollLeft += right - end + 4;
}

function render() {
  if (libraryPage) {
    renderCatalogResults(main);
    return;
  }
  const id = route();
  const tab = query(`#tab-${id}`);
  const panel = query('#workspace-panel');
  const previousTab = panel.getAttribute('aria-labelledby');
  const tabChanged = previousTab && previousTab !== tab.id;
  const focusWasInPanel = panel.contains(document.activeElement);

  current.mountToken++;
  for (const item of main.querySelectorAll('.workspace-tab')) {
    item.setAttribute('aria-selected', item === tab);
    item.tabIndex = item === tab ? 0 : -1;
  }
  panel.setAttribute('aria-labelledby', tab.id);
  panel.innerHTML = {
    overview, inquiry, product, print, scenes: scenePictures, packaging, versions, replies,
  }[id]();
  if (tabChanged) {
    if (focusWasInPanel) panel.focus({ preventScroll: true });
    if (panel.getBoundingClientRect().top < 0) panel.scrollIntoView({ block: 'start', inline: 'nearest' });
  }
  if (!previousTab || tabChanged) revealWorkspaceTab(tab);
  if (id === 'print' && query('#artwork-canvas')) void preparePrint();
  if (id === 'inquiry') scheduleInquiry();
}

function overview() {
  const { product: item, demo } = state.kit;
  const recent = state.versions[0]?.version;
  const quantity = state.buyer.quantity;
  return `<section class="hero">
    <div class="hero-copy"><span class="eyebrow">${escape(demo.id.toUpperCase())} <b>·</b> 酒店采购演示</span>
      <h2>柠檬蓝花</h2><p class="hero-english">Lemon &amp; Blue Flowers</p>
      <p class="hero-description">准备杯碟、印花和包装方案。选定效果图后，生成可下载的英文提案。</p>
      <div class="actions"><a href="#versions" class="button secondary">打开提案</a><a href="#inquiry" class="button primary">处理询盘</a></div>
    </div>
    <div class="hero-photo">${image(state.selected.lifestyle)}<span>${state.selected.lifestyle ? escape(imageName(asset(state.selected.lifestyle))) : '场景未选图'}</span></div>
  </section>
  <div class="overview-metrics">
    <article><span>主推货号</span><strong>${escape(item.sku)}</strong><small>${escape(item.nameZh)}</small></article>
    <article><span>采购量</span><strong>${quantity == null ? '待确认' : `${escape(quantity)} <small>套</small>`}</strong><small>${quantity == null ? '等客户确认数量' : escape(labelFor(qtyLabel, state.buyer.quantityQualifier) || '数量已填写')}</small></article>
    <article><span>包装方向</span><strong>2 <small>款</small></strong><small>折叠彩盒与硬质礼盒</small></article>
    <article><span>已保存提案</span><strong>${recent ? `V${recent}` : '待保存'}</strong><small>${recent ? '英文四页 PDF' : '可直接保存提案'}</small></article>
  </div>
  <div class="subheading"><h2>当前选稿</h2><a class="text-link" href="#versions">管理提案选图</a></div>
  <div class="gallery-grid">${Object.entries(labels).map(([slot, label]) => {
    const item = asset(state.selected[slot]);
    return `<article class="gallery-card"><div class="gallery-image">${image(item?.id)}</div><div class="gallery-meta">
      <strong>${label}</strong>${chip(item ? kindNames[item.kind] : '未选图')}</div></article>`;
  }).join('')}</div>
  ${factoryNotice()}`;
}

const fieldLabels = {
  use: '使用场景', quantity: '数量', quantityQualifier: '数量说明', earlierQuantity: '早期数量', quantityCandidates: '原文候选数量',
  quantitySource: '数量来源', sku: '货号', print: '印花要求', packaging: '包装要求',
  keep: '保留项', change: '修改项', newVersion: '新版本', keepPreviousVersion: '保留上一版本', ignoredInstruction: '已识别的外来指令',
};
const useLabels = { 'hotel breakfast': '酒店早餐', 'afternoon tea': '下午茶', 'café service': '咖啡馆用餐' };
const packagingLabels = {
  'gift box': '礼盒', 'rigid gift box': '硬质礼盒', 'folding carton': '折叠彩盒', 'pack-a': '包装 A', 'pack-b': '包装 B',
};
const printLabels = { 'print-a': '印花 A', 'print-b': '印花 B', 'plain white': '白瓷无印花', 'logo on cup front': '杯身正面印 Logo' };
const packagingText = values => values.map(value => labelFor(packagingLabels, value)).join('、');
const suggestedPack = values => /gift box|礼盒|pack-b/i.test(values[0] ?? '') ? 'B' : 'A';
const displayValue = value => Array.isArray(value) ? (value.join('、') || '未提供') : typeof value === 'boolean' ?
  (value ? '是' : '否') : (value === null || value === undefined || value === '' ? '未提供' : String(value));

const inquiryText = () => drafts.text ?? state.inquiry?.text ?? '';
const inquiryChanged = text => text.trim() ? text !== state.inquiry?.text : Boolean(state.inquiry);
const inquiryEdits = () => state.inquiry?.review ?? {};
const currentInquiry = () => inquiryText() === state.inquiry?.text && state.inquiry?.result
  ? { ...state.inquiry.result, ...inquiryEdits() } : null;

function inquiryConflicts(result) {
  const edits = inquiryEdits();
  return {
    quantity: Boolean(result?.quantityCandidates?.length) && !(Object.hasOwn(edits, 'quantity') && result.quantity > 0),
    sku: Array.isArray(result?.evidence?.sku) && !(Object.hasOwn(edits, 'sku') && result.sku),
  };
}

function inquiryReviewBadge() {
  const { quantity, sku } = inquiryConflicts(currentInquiry());
  return quantity || sku ? chip('需核对', 'warm') : '';
}

function inquiryAdoption() {
  const result = inquiryError ? null : currentInquiry();
  const hasUse = Boolean(result?.use);
  const hasQuantity = Number.isSafeInteger(result?.quantity) && result.quantity > 0 &&
    (!result.needsReview || Object.hasOwn(inquiryEdits(), 'quantity'));
  const fields = hasUse && !hasQuantity ? '用途' : hasQuantity && !hasUse ? '数量' : '用途与数量';
  let hint = '';
  if (!result) hint = '提取完成后，可将用途或数量带入提案。';
  else if (inquiryConflicts(result).quantity) hint = '请核对原文中的数量，在编辑结果里填写客户确认的值。';
  else if (inquiryConflicts(result).sku) hint = '请核对客户货号，可在编辑结果里填写确认后的值。';
  else if (!hasUse && !hasQuantity) hint = '当前原文未识别到可采用的用途或数量。';
  const ready = Boolean(result) && !pending && !inquiryReadingFile && !inquiryComposing;
  return { result, fields, hint, hasUse, hasQuantity, ready, enabled: (hasUse || hasQuantity) && ready };
}

function inquiryNext({ result, hasUse, hasQuantity, ready }) {
  if (!result) return null;
  const packaging = result.packaging ?? [];
  const missing = [!hasUse && '用途', !hasQuantity && '数量'].filter(Boolean);
  const hint = missing.length ? `${missing.join('、')}待客户确认，可先准备方案。` : '按本次询盘的要求准备提案。';
  if (isBlank() && !hasProduct()) return {
    title: '准备商品资料', label: '继续填写商品资料', page: 'product', hint, ready,
  };
  if (packaging.length) return {
    title: `包装要求 · ${packagingText(packaging)}`, label: '继续做包装方案', page: 'packaging', hint, ready,
  };
  if (result.print) return {
    title: `印花要求 · ${labelFor(printLabels, result.print)}`, label: '继续做印花方案', page: 'print', hint, ready,
  };
  return { title: '准备提案草稿', label: '继续准备提案', page: 'versions', hint, ready };
}

function inquiryNextMarkup(next) {
  if (!next) return '';
  return `<div class="inquiry-next"><strong>${escape(next.title)}</strong><p class="hint">${escape(next.hint)}</p></div>`;
}

function draftInquiryNotice(withProposalLink = false) {
  const buyer = state.buyer;
  if (!Array.isArray(buyer.packaging)) return '';
  const sku = state.kit.product?.sku;
  const qualifier = labelFor(qtyLabel, buyer.quantityQualifier);
  const details = [
    buyer.packaging.length && `包装要求 ${packagingText(buyer.packaging)}`,
    buyer.packaging.length && (buyer.packagingConfirmed ? '包装已获客户确认' : '包装待客户确认'),
    buyer.print && `印花要求 ${labelFor(printLabels, buyer.print)}`,
    buyer.sku && `客户货号 ${buyer.sku}`,
    buyer.sku && sku && buyer.sku !== sku && `当前方案使用货号 ${sku}，请核对商品。`,
    buyer.use ? `用途 ${labelFor(useLabels, buyer.use)}` : '用途待客户确认',
    buyer.quantity == null ? '数量待客户确认' : `数量 ${buyer.quantity} 套${qualifier ? `（${qualifier}）` : ''}`,
  ].filter(Boolean);
  return `<aside class="notice inquiry-context" aria-label="本次询盘需求"><strong>本次询盘</strong>
    ${details.map(value => `<span>${escape(value)}</span>`).join('')}
    ${withProposalLink ? '<a href="#versions" class="text-link">查看提案</a>' : ''}</aside>`;
}

function inquiryResults() {
  if (inquiryError) return `<p class="empty">${escape(inquiryError)}</p>
    <div class="actions">${button('重试识别', 'inquiry-retry', '', 'button secondary')}</div>`;
  const result = currentInquiry();
  if (!result) return `<p class="empty">${inquiryText().trim() ? '正在识别询盘…' : '输入客户原文后显示识别结果和原文依据。'}</p>`;
  const edits = inquiryEdits();
  const factoryConfirmed = state.kit.product?.factoryConfirmed === true;
  const valueLabels = { use: useLabels, quantityQualifier: qtyLabel, print: printLabels };
  return `<div class="field-results">${Object.entries(fieldLabels).filter(([key]) =>
        Object.hasOwn(result, key) && result[key] !== false &&
        (key !== 'ignoredInstruction' || result.evidence?.ignoredInstruction)).map(([key, label]) => {
          const quotes = [result.evidence?.[key]].flat().filter(Boolean);
          const value = key === 'packaging' ? packagingText(result.packaging ?? []) :
            valueLabels[key] ? labelFor(valueLabels[key], result[key]) : result[key];
          return `<div class="field-result" data-inquiry-field="${key}"><div class="field-result-label"><small>${label}</small>
            ${Object.hasOwn(edits, key) ? chip('人工修正', 'green') : ''}</div><strong>${escape(displayValue(value))}</strong>
            ${quotes.length ? quotes.map(quote => `<q>${escape(quote)}</q>`).join('') : ''}</div>`;
        }).join('')}</div>
    <section class="inquiry-statuses" aria-labelledby="inquiry-statuses-heading"><h3 id="inquiry-statuses-heading">确认状态</h3>
      <div class="field-results">
        <div class="field-result" data-inquiry-field="packagingConfirmed"><div class="field-result-label"><small>包装确认</small>
          ${Object.hasOwn(edits, 'packagingConfirmed') ? chip('人工记录', 'green') : ''}</div>
          <strong>${result.packagingConfirmed ? '客户已确认' : '待客户确认'}</strong>
          ${result.packagingConfirmed ? '' : '<p class="tiny">可先准备包装方案。客户选定后，在「编辑结果」里记录。</p>'}
          ${result.evidence?.packagingConfirmed ? `<q>${escape(result.evidence.packagingConfirmed)}</q>` : ''}
        </div>
        <div class="field-result" data-inquiry-field="factoryConfirmed"><small>生产规格</small>
          <strong>${factoryConfirmed ? '工厂已确认' : '待工厂确认'}</strong>
          ${factoryConfirmed ? '' : `<a class="text-link tiny" href="${factoryUrl()}" download>下载工厂确认清单</a>`}
        </div>
      </div>
    </section>`;
}

function inquiry() {
  const adoption = inquiryAdoption();
  const next = inquiryNext(adoption);
  return `${heading('询盘提取', '输入原文或上传文件，自动识别客户的用途、数量、印花和包装要求。')}
  <div class="split-layout inquiry-layout">
    <section class="card pane inquiry-input"><h2 id="inquiry-text-label">客户原文</h2>
      <textarea id="inquiry-text" aria-labelledby="inquiry-text-label" rows="10" maxlength="16000" placeholder="粘贴客户邮件、聊天记录或跟进消息…">
${escape(inquiryText())}</textarea>
      <div class="actions">
        ${button('上传文件', 'inquiry-upload', `id="inquiry-upload-button" aria-describedby="inquiry-file-status" ${pending || inquiryReadingFile ? 'disabled' : ''}`, 'button secondary')}
        <input id="inquiry-file" type="file" accept=".txt,.md,.docx,.pdf" hidden>
      </div>
      <p id="inquiry-file-status" class="tiny" role="status">${escape(inquiryFileMessage || inquiryFileHint)}</p>
    </section>
    <section class="card pane inquiry-output"><div class="pane-title"><h2>提取结果</h2><span id="inquiry-review">${inquiryReviewBadge()}</span>
      ${button('编辑结果', 'inquiry-edit', `id="inquiry-edit-button" ${adoption.result ? '' : 'hidden'} ${adoption.ready ? '' : 'disabled'}`, 'button secondary button-sm')}</div>
      <div id="inquiry-next">${inquiryNextMarkup(next)}</div>
      <div id="inquiry-results" aria-live="polite">${inquiryResults()}</div>
      <div class="inquiry-adoption">
        <div class="actions">
          ${button(`采用${adoption.fields}`, 'buyer', `id="inquiry-adopt-button" aria-describedby="inquiry-adopt-hint" ${adoption.enabled ? '' : 'disabled'}`, 'button secondary')}
          ${button(next?.label ?? '', 'inquiry-continue', `id="inquiry-continue-button" ${next ? '' : 'hidden'} ${next?.ready ? '' : 'disabled'}`, 'button primary')}
        </div>
        <p id="inquiry-adopt-hint" class="tiny" role="status">${adoption.hint}</p>
      </div>
    </section>
  </div>`;
}

function refreshInquiryResults() {
  const panel = query('#inquiry-results');
  if (!panel) return;
  const markup = inquiryResults();
  if (panel.innerHTML !== markup) panel.innerHTML = markup;
  query('#inquiry-review').innerHTML = inquiryReviewBadge();
  const adoption = inquiryAdoption();
  const editButton = query('#inquiry-edit-button');
  editButton.hidden = !adoption.result;
  editButton.disabled = !adoption.ready;
  const next = inquiryNext(adoption);
  const summary = query('#inquiry-next');
  const nextMarkup = inquiryNextMarkup(next);
  if (summary.innerHTML !== nextMarkup) summary.innerHTML = nextMarkup;
  const continueButton = query('#inquiry-continue-button');
  continueButton.hidden = !next;
  continueButton.disabled = !next?.ready;
  const continueLabel = next?.label ?? '';
  if (continueButton.textContent !== continueLabel) continueButton.textContent = continueLabel;
  const adoptButton = query('#inquiry-adopt-button');
  const adoptLabel = `采用${adoption.fields}`;
  if (adoptButton.textContent !== adoptLabel) adoptButton.textContent = adoptLabel;
  adoptButton.disabled = !adoption.enabled;
  const adoptHint = query('#inquiry-adopt-hint');
  if (adoptHint.textContent !== adoption.hint) adoptHint.textContent = adoption.hint;
  query('#inquiry-upload-button').disabled = pending || inquiryReadingFile;
  const fileStatus = query('#inquiry-file-status');
  const fileMessage = inquiryFileMessage || inquiryFileHint;
  if (fileStatus.textContent !== fileMessage) fileStatus.textContent = fileMessage;
}

function scheduleInquiry() {
  clearTimeout(inquiryTimer);
  if (state && route() === 'inquiry' && !pending && !inquiryReadingFile && !inquiryComposing && !inquiryError && inquiryChanged(inquiryText())) {
    inquiryTimer = setTimeout(extractInquiryDraft, 450);
  }
}

async function extractInquiryDraft() {
  const text = inquiryText();
  if (route() !== 'inquiry' || pending || inquiryReadingFile || inquiryComposing || !inquiryChanged(text)) return;
  clearTimeout(inquiryTimer);
  pending = true;
  refreshInquiryResults();
  try {
    await request('/api/inquiry', { text });
  } catch (error) {
    if (error.status === 409) {
      try { state = await request('/api/workspace'); }
      catch { /* Keep the current draft available for retry. */ }
    }
    if (inquiryText() === text && inquiryChanged(text)) inquiryError = error.status ? error.message : '暂时无法识别，请重试。';
  } finally {
    pending = false;
    refreshInquiryResults();
    scheduleInquiry();
  }
}

function updateInquiryDraft(value) {
  drafts.text = value;
  inquiryError = '';
  refreshInquiryResults();
  scheduleInquiry();
}

async function importInquiryFile(file) {
  if (inquiryReadingFile) return;
  const previousText = inquiryText();
  inquiryReadingFile = true;
  inquiryFileMessage = `正在读取 ${file.name}…`;
  clearTimeout(inquiryTimer);
  refreshInquiryResults();
  try {
    if (file.size > 8 * 1024 * 1024) throw new Error('文件超过 8 MB，请选择较小的文件。');
    const content = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('无法读取文件，请重新选择。'));
      reader.readAsDataURL(file);
    });
    const { text } = await request('/api/inquiry/upload', { filename: file.name, content });
    if (inquiryText() !== previousText || inquiryComposing) {
      inquiryFileMessage = '已保留输入框中的新内容。要导入文件，请重新选择。';
      return;
    }
    const editor = query('#inquiry-text');
    if (editor) editor.value = text;
    inquiryFileMessage = `已导入 ${file.name}`;
    updateInquiryDraft(text);
  } catch (error) {
    inquiryFileMessage = error.message === 'Failed to fetch' ? '暂时无法读取文件，请重试。' : error.message;
  } finally {
    inquiryReadingFile = false;
    refreshInquiryResults();
    scheduleInquiry();
  }
}

function product() {
  const item = state.kit.product;
  const fields = drafts.product ?? item;
  const next = designPage();
  return `${heading('商品资料', isBlank() ? '填写商品信息并上传提案和印花设计要用的图片。' : '查看提案使用的商品信息和套装内容。')}
  ${isBlank() ? `<form id="product-form" class="card pane" aria-label="编辑商品信息">
    <h2>基本信息</h2>
    <div class="product-fields">
      <label>货号<input name="sku" required maxlength="48" value="${escape(fields?.sku ?? state.buyer.sku ?? '')}"></label>
      <label>商品名称<input name="nameZh" required maxlength="120" value="${escape(fields?.nameZh ?? '')}"></label>
      <label>英文名称 <small class="tiny">选填，用于英文提案</small><input name="nameEn" maxlength="120" value="${escape(fields?.nameEn ?? '')}"></label>
    </div>
    <div class="actions"><button class="button primary" type="submit">保存商品信息</button></div>
  </form>
  <section class="card pane after"><h2>商品图片</h2><div class="product-materials">
    ${[
      ['source', '商品主图', '用于英文提案和印花贴图，支持 PNG、JPEG。', state.selected.source],
      ['artwork', '印花素材', '支持 JPG、PNG 和 WebP，可预览并去除背景。', state.artworkId],
    ].map(([slot, label, help, id]) => `<article class="material-row"><div class="material-preview">${image(id)}</div>
      <div><strong>${label}</strong><p class="tiny">${help}</p></div>
      <div class="actions">${id ? viewButton(id) : ''}${button(id ? '更换图片' : '上传图片', 'product-upload', `data-slot="${slot}" aria-label="${id ? '更换' : '上传'}${label}"`, 'button secondary button-sm')}
        ${slot === 'source' ? button('从资料库选择', 'catalog-pick', '', 'button primary button-sm') : ''}
        <input id="product-file-${slot}" type="file" data-product-image="${slot}" accept="image/png,image/jpeg${slot === 'artwork' ? ',image/webp,.jpg,.jpeg,.png,.webp' : ''}" hidden>
      </div></article>`).join('')}
  </div>
  <div class="actions">
    <a class="button primary" href="#${next}">${next === 'print' ? '继续做印花方案' : '继续做场景图'}</a>
  </div></section>` : `<section class="card pane"><div class="pane-title"><h2>${escape(item.nameZh)}</h2>${chip(`货号 ${item.sku}`, 'green')}</div>
    <p>套装包含一杯一碟。</p>
  </section>`}`;
}

const staleImage = item => item?.sceneStale === true || item?.packStale === true;

function scenePictures() {
  const cover = asset(state.selected.lifestyle);
  const candidates = candidateList('lifestyle');
  const jobs = state.jobs.filter(job => job.slot === 'lifestyle' && job.status !== 'succeeded');
  const running = sceneGenerating || jobs.some(job => job.status === 'running');
  const missingSource = !state.selected.source;
  const missingPrint = missingScenePrint();
  const needsPackaging = Boolean(state.buyer.packaging?.length);
  return `${heading('场景图片', '用商品主图和已选印花生成使用场景，确认后可选为提案封面。')}
  ${draftInquiryNotice()}
  <section class="card pane scenes-panel" aria-labelledby="scenes-heading">
    <div class="material-row"><div class="material-preview">${image(cover?.id)}</div>
      <div><h2 id="scenes-heading">提案封面</h2>
        <p class="tiny">${cover ? `当前封面 · ${escape(imageName(cover))}` : '选择使用场景，生成后可选为提案封面。'}</p>
      </div>
      <div class="actions">
        ${button('上传场景图', 'product-upload', 'data-slot="lifestyle"', 'button secondary button-sm')}
        ${button(running ? '场景图生成中…' : 'AI 生成场景图', 'scene-new', missingSource || missingPrint || running ? 'disabled' : '', 'button primary button-sm')}
        <input id="product-file-lifestyle" type="file" data-product-image="lifestyle" accept="image/png,image/jpeg" hidden>
      </div>
    </div>
    ${missingSource || missingPrint ? `<div class="notice compact">
      <strong>${missingSource ? '请先选用商品主图' : '请先选定印花方案'}</strong>
      <span>${missingSource ? '在商品资料中上传主图或从资料库选择商品。' : '在印花设计里保存贴图，并点击「选入提案」。'}</span>
      <a class="text-link" href="#${missingSource ? 'product' : 'print'}">${missingSource ? '前往商品资料' : '前往印花设计'}</a>
    </div>` : ''}
    ${candidates.length ? `<div class="subheading"><h3>场景图选稿</h3>
        ${!cover && candidates.some(item => !staleImage(item)) ? '<span class="tiny">选一张作为提案封面，即可继续下一步。</span>' : ''}
      </div>
      <div class="candidate-grid">${candidates.map(item => candidateCard(item, 'lifestyle')).join('')}</div>` : ''}
    ${jobs.length ? `<ul class="jobs scene-jobs">${jobs.map(job => `<li>
      <div><strong>${escape(sceneLabel(job.scene))} · ${{ failed: '生成失败', needs_review: '待核对百炼任务', running: '生成中' }[job.status] ?? '已核对'}</strong>
        <span class="tiny">${formatDate(job.createdAt)}${job.providerRequestId ? ` · 请求 ${escape(job.providerRequestId)}` : ''}</span>
        ${job.error ? `<p>${escape(job.error)}</p>` : ''}</div>
      ${job.status === 'failed' && !running ? button('重新生成', 'scene-retry', `data-id="${job.id}"`, 'button flat button-sm') : ''}
      ${job.status === 'needs_review' ? button('核对任务', 'scene-resolve', `data-id="${job.id}"`, 'button secondary button-sm') : ''}
      ${job.status === 'running' && !sceneGenerating ? button('刷新状态', 'job-refresh', '', 'button flat button-sm') : ''}
    </li>`).join('')}</ul>` : ''}
  </section>
  ${cover ? `<div class="actions after">
    <a class="button primary" href="#${needsPackaging ? 'packaging' : 'versions'}">${needsPackaging ? '继续做包装方案' : '继续准备提案'}</a>
  </div>` : ''}`;
}

function sceneLabel(id) {
  return state.scenePresets?.find(preset => preset.id === id)?.label ?? '场景图';
}

function recommendedScene(use) {
  if (/酒店.{0,8}早餐|hotel\s+breakfast/i.test(use)) return 'hotel-breakfast';
  if (/下午茶|afternoon\s+tea/i.test(use)) return 'afternoon-tea';
  if (/咖啡馆|咖啡店|caf[eé]|coffee\s+shop/i.test(use)) return 'cafe';
  return '';
}

const sceneDescriptionTemplates = {
  'hotel-breakfast': [
    ['酒店窗边早餐', '布置在酒店窗边早餐桌，使用白色亚麻桌布和柔和晨光，远处点缀少量果盘，商品居于画面前景。'],
    ['现代酒店餐厅', '使用浅色石材桌面和温润晨光，背景轻微虚化，少量早餐餐具沿画面边缘摆放，完整展示商品外形。'],
  ],
  'afternoon-tea': [
    ['明亮窗边茶席', '在自然窗光下布置浅色亚麻桌布，点缀少量茶点，保持桌面留白，重点展示商品正面。'],
    ['复古花园下午茶', '使用浅木桌和午后柔光，背景有虚化的花园绿植，配少量糕点，商品摆在画面前景。'],
  ],
  cafe: [
    ['木质咖啡吧台', '将商品放在暖色木质吧台上，背景保留虚化的咖啡机和自然光，完整展示商品轮廓。'],
    ['暖光咖啡馆角落', '布置在咖啡馆的靠窗桌位，室内暖光与柔和窗光交织，背景虚化，保留干净的商品展示区域。'],
  ],
  common: [
    ['简约浅色桌面', '使用浅色桌面与柔和侧光，布置少量同色道具，让商品在干净留白中成为画面主体。'],
    ['自然光近景', '采用自然侧光和近景构图，背景轻微虚化，保留商品完整轮廓，突出釉面质感与正面细节。'],
  ],
};

function candidateCard(item, slot, review = false) {
  const active = state.selected[slot] === item.id;
  const scene = slot === 'lifestyle';
  const stale = staleImage(item);
  const status = review ? state.packing[slot.at(-1)].reviewed[item.id] : null;
  const builtIn = ['ai_preview', 'demo_illustration'].includes(item.kind);
  const ready = !stale && (!review || builtIn || status === 'approved');
  const name = escape(imageName(item));
  return `<article class="candidate ${active ? 'is-selected' : ''}">
    <button type="button" class="candidate-thumb" data-action="image" data-id="${item.id}" aria-label="查看 ${name}">${image(item.id)}</button>
    <div class="candidate-body"><div class="pane-title"><strong>${name}</strong>
    ${stale ? chip('参考图已更换', 'warm') : active ? chip(scene ? '当前封面' : '当前选稿', 'green') : status === 'rejected' ? chip('需重做', 'warm') : status === 'approved' ? chip('视觉审核通过', 'green') : chip(kindNames[item.kind])}</div>
    ${item.notes ? `<p class="tiny">${escape(item.notes)}</p>` : ''}${item.createdAt ? `<time class="tiny">${formatDate(item.createdAt)}</time>` : ''}
    <div class="actions">
      ${review && !builtIn && !active && !stale ? button('审核', 'review', `data-id="${item.id}"`, 'button flat button-sm') : ''}
      ${ready && !active ? button(scene ? '选为封面' : '选入提案', 'select', `data-slot="${slot}" data-id="${item.id}"`, 'button secondary button-sm') : ''}
    </div></div>
  </article>`;
}

const slider = (label, key, min, max, step, value) => `<label class="slider"><span>${label}</span><input type="range"
  data-position="${key}" min="${min}" max="${max}" step="${step}" value="${value}"><output>${display(key, value)}</output></label>`;

function sceneNext() {
  return `<div class="actions after">${missingScenePrint()
    ? '<span class="tiny">选定印花后可继续做场景图。</span>'
    : '<a class="button primary" href="#scenes">继续做场景图</a>'}</div>`;
}

function print() {
  const option = current.print;
  const slot = `print${option}`;
  const blank = isBlank();
  if (blank && (!state.selected.source || !state.artworkId)) {
    return `${heading('印花设计', '使用商品主图和透明印花素材制作贴图方案。')}
      ${draftInquiryNotice(true)}
      <section class="card pane"><h2>补充印花素材</h2><p>请在「商品资料」上传商品主图和印花素材。</p>
        <div class="actions"><a class="button primary" href="#product">前往商品资料</a></div>
      </section>
      ${state.selected.source ? sceneNext() : ''}`;
  }
  const printConfig = state.kit.print;
  const pos = current.revision[option] ??= { ...state.prints[option] };
  const area = printConfig.editableArea;
  return `${heading('印花设计', blank ? '在商品主图上调整印花位置、大小和角度。' : '调整 146 杯身上的印花位置、大小和角度。', optionSwitch('print', option))}
  ${draftInquiryNotice(true)}
  <section class="card artwork-panel"><div class="artwork-image">
    <canvas id="artwork-canvas" aria-label="商品印花贴图预览"></canvas><p id="artwork-status" class="tiny" role="status">正在加载贴图预览…</p>
  </div><div class="pane artwork-controls">
    <div class="pane-title"><h2>Print ${option}</h2>${chip(blank ? '视觉预览' : '146 · 视觉预览', 'green')}</div>
    <p class="hint">拖动图案或调节滑杆，确认构图后保存候选稿。</p>
    ${slider('缩放', 'widthRatio', 0.07, 0.42, 0.001, pos.widthRatio)}
    ${slider('旋转', 'rotationDegrees', -180, 180, 1, pos.rotationDegrees)}
    ${slider('水平位置', 'centerX', area.x, area.x + area.width, 0.001, pos.centerX)}
    ${slider('垂直位置', 'centerY', area.y, area.y + area.height, 0.001, pos.centerY)}
    <div class="actions">${button('复位', 'print-reset', '', 'button flat')}${button('保存贴图候选', 'print-save', 'id="save-art" disabled', 'button primary')}</div>
    <p class="tiny">位置与大小按底图比例记录。真实印花尺寸与曲面效果需打样确认。</p>
  </div></section>
  <div class="subheading"><h2>Print ${option} 候选稿</h2><span class="tiny">打开历史稿保持当前选稿</span></div>
  <div class="candidate-grid">${candidateList(slot).map(item => candidateCard(item, slot)).join('')}</div>
  ${sceneNext()}`;
}

let activeArtwork;
async function preparePrint() {
  activeArtwork = null;
  const token = current.mountToken;
  try {
    const art = await mountArtwork(query('#artwork-canvas'), current.revision[current.print], state.kit.print, {
      photoId: isBlank() ? state.selected.source : 'source-146',
      artworkId: state.artworkId,
      customArtwork: isBlank(),
    });
    if (token !== current.mountToken) return;
    activeArtwork = art;
    query('#save-art').disabled = false;
    query('#artwork-status').hidden = true;
  } catch (error) {
    if (token === current.mountToken) query('#artwork-status').textContent = error.message;
  }
}

const reviewLabels = ['杯把与方碟轮廓正确', '一杯一碟', '杯身印花符合选定参考', '外包装装饰克制', '无未经确认的生产尺寸'];
const customReviewLabels = ['商品与包装方案一致', '图案与文字清晰', '符合客户的包装要求', '无未经确认的生产尺寸'];

function packaging() {
  const option = current.pack;
  const slot = `pack${option}`;
  const preset = state.kit.packPresets[option];
  const blank = isBlank();
  const candidates = candidateList(slot);
  const base = state.selected[slot] || (blank ? candidates.find(item => !staleImage(item))?.id : `pack-${option.toLowerCase()}-kit`);
  const preview = asset(base);
  const selected = preview?.id === state.selected[slot];
  const sources = candidates.map(item => `<option value="${item.id}" ${item.id === base ? 'selected' : ''}>${escape(imageChoice(item, candidates))}</option>`).join('');
  const jobs = state.jobs.filter(job => job.slot === slot);
  const modelRunning = generatingPack === option || jobs.some(job => job.mode === 'model' && job.status === 'running');
  const unresolved = jobs.some(job => job.mode === 'model' && job.status === 'needs_review');
  const ready = Boolean(state.modelAvailable && state.selected.source && !missingScenePrint() && !modelRunning && !unresolved);
  const printChoices = ['printA', 'printB'].filter(key => state.selected[key]).map(key =>
    `<option value="${state.selected[key]}">${labels[key]} 当前选稿</option>`).join('');
  return `${heading('包装审稿', blank ? '生成或上传包装效果图，完成视觉审核后选入提案。' : '分别生成或上传 Pack A/B 候选，审核后选入提案。', optionSwitch('pack', option))}
  ${draftInquiryNotice()}
  <div class="split-layout pack-layout">
    <section class="card pane"><div class="pane-title"><h2>Pack ${option}</h2>${preview ? chip(selected ? '已选入提案' : '候选预览', selected ? 'green' : '') : ''}</div>
      <div class="pack-image">${preview ? image(preview.id) : `<div class="pack-empty" role="status">
        <strong>${modelRunning ? '正在生成包装图' : '暂无包装效果图'}</strong>
        <p class="tiny">${modelRunning ? '生成完成后会在这里显示候选稿。' : '生成或上传这个包装选项的图片后，可在这里预览。'}</p>
      </div>`}</div>
      ${preview ? `<div class="actions">${viewButton(preview.id)}</div>` : ''}
      ${blank ? '' : `<p class="hint"><span class="swatch" style="background:${preset.colorHex}"></span>${option === 'A' ? '浅鼠尾草绿 · 同色柠檬枝暗纹' : '深森林绿 · 小面积烫金柠檬枝'}</p>`}
    </section>
    <section class="card pane pack-editor"><h2>制作候选稿</h2>
      <label for="pack-brief">${blank ? '包装要求（选填）' : '改稿要求'}</label><textarea id="pack-brief" rows="3" maxlength="1500" placeholder="${blank ? '可补充盒面颜色、材质质感或摆放要求。' : '例如：浅一点的绿色，保留烫金柠檬枝'}">${escape(drafts[option])}</textarea>
      ${blank ? '' : `<div class="two-fields"><div><label for="pack-base">改稿底图</label><select id="pack-base">${sources}</select></div>
        <div><label for="pack-treatment">本地操作</label><select id="pack-treatment"><option value="copy">复制为候选</option><option value="lighter">调浅盒面</option><option value="darker">调深盒面</option></select></div></div>`}
      ${blank ? `${!state.selected.source ? '<p class="tiny"><a class="text-link" href="#product">先在商品资料选用主图</a></p>' :
          missingScenePrint() ? '<p class="tiny"><a class="text-link" href="#print">先在印花设计选定印花</a></p>' :
          !state.modelAvailable ? `<p class="tiny">${state.sceneModelAvailable ? '请重启本地工作台以加载包装生成功能。' :
            `在${button('配置模型', 'model-settings', '', 'text-link')}中保存百炼密钥后即可生成。`}</p>` : ''}
        ${unresolved ? '<p class="tiny">请先核对这个包装选项的上一笔生成任务。</p>' : ''}` : ''}
      <div class="actions">${button('上传包装图', 'pack-upload', 'title="支持 PNG 和 JPEG 图片"', 'button secondary')}
      ${blank ? button(modelRunning ? '包装图生成中…' : 'AI 生成包装图', 'pack-model', ready ? '' : 'disabled', 'button primary') : button('生成本地候选', 'pack-local', '', 'button primary')}
      <input hidden id="pack-file" type="file" accept="image/png,image/jpeg"></div>
      ${blank ? '' : `<div class="provider"><div><strong>百炼模型</strong><p class="tiny">${state.modelAvailable ? '提交需确认，模型可能计费。' : '保存密钥后即可生成。'}</p></div>
        ${state.modelAvailable ? `<div class="actions"><select id="pack-print-guide" aria-label="指定印花参考"><option value="">不指定印花参考</option>${printChoices}</select>${button(modelRunning ? '包装图生成中…' : '模型生成', 'pack-model', modelRunning || unresolved ? 'disabled' : '', 'button secondary button-sm')}</div>` : button('配置模型', 'model-settings', '', 'button secondary button-sm')}</div>`}
    </section>
  </div>
  <div class="subheading"><h2>Pack ${option} 候选稿</h2>${blank ? '' : '<span class="tiny">打开大图和生成候选均保持当前选稿</span>'}</div>
  <div class="candidate-grid">${candidates.map(item => candidateCard(item, slot, true)).join('')}</div>
  ${jobs.length ? `<section class="card pane after"><h2>生成与重试记录</h2><ul class="jobs">${jobs.map(job => `<li>
    <div><strong>${{ local: '本地处理', model: '百炼模型', upload: '图片导入' }[job.mode]} · ${{ succeeded: '已完成', failed: '生成失败', needs_review: '待查询模型状态', running: '生成中' }[job.status]}</strong>
    <span class="tiny">${formatDate(job.createdAt)} ${escape(job.brief)}${job.providerRequestId ? ` · 请求 ${escape(job.providerRequestId)}` : ''}</span>${job.error ? `<p>${escape(job.error)}</p>` : ''}</div>
    ${job.status === 'failed' ? button('带回要求重试', 'retry', `data-id="${job.id}"`, 'button flat button-sm') : ''}
    ${job.status === 'running' && generatingPack !== option ? button('刷新状态', 'job-refresh', '', 'button flat button-sm') : ''}
    ${job.status === 'needs_review' ? button('确认已核对', 'job-resolve', `data-id="${job.id}"`, 'button secondary button-sm') : ''}</li>`).join('')}</ul></section>` : ''}
  <div class="actions after"><a class="button primary" href="#versions">继续准备提案</a></div>`;
}

function versions() {
  const ready = !isBlank() || hasProduct();
  return `${heading('提案与版本', '按选稿生成四页英文 PDF，保留每次保存的图片与文件。',
    button(state.versions.length ? '保存新版本' : '保存 V1 提案', 'save-version', ready ? '' : 'disabled aria-describedby="proposal-prerequisite"', 'button primary'))}
    ${draftInquiryNotice()}
    ${ready ? '' : '<div class="notice inquiry-context" id="proposal-prerequisite"><strong>补充商品资料后可保存提案</strong><span>填写货号和商品名称，并上传商品主图。</span><a class="text-link" href="#product">前往商品资料</a></div>'}
    <section class="card pane"><div class="pane-title"><h2>本次提案选图</h2>${state.kit.product ? chip(`货号 ${state.kit.product.sku} · 四页英文`, 'green') : ''}</div>
    <div class="selection-grid">${Object.entries(proposalImageLabels).map(([slot, label]) => {
      const id = state.selected[slot];
      const item = asset(id);
      const available = candidateList(slot).filter(entry => !staleImage(entry) &&
        (!slot.startsWith('pack') || ['ai_preview', 'demo_illustration'].includes(entry.kind) ||
          state.packing[slot.at(-1)].reviewed[entry.id] === 'approved'));
      return `<article class="selection"><div class="selection-image">${image(id)}</div><strong>${label}</strong>
        <select data-select-slot="${slot}" aria-label="${label}选稿"><option value="">未选图</option>
        ${available.map(entry => `<option value="${entry.id}" ${id === entry.id ? 'selected' : ''}>${escape(imageChoice(entry, available))}</option>`).join('')}</select>
        <small>${item ? escape(kindNames[item.kind]) : slot === 'lifestyle' && isBlank() ? '封面将使用商品主图' : '导出时该位置留空'}</small></article>`;
    }).join('')}</div></section>
    <div class="subheading"><h2>已保存版本</h2></div>
    <section class="card pane">${state.versions.length ? `<ul class="versions-list">${state.versions.map(entry => `
      <li><span class="version-mark">V${entry.version}</span><div class="version-copy"><strong>${state.project.isDemo ? 'Lemon &amp; Blue Flowers' : escape(entry.snapshot.collection)}</strong>
        <time class="tiny">${formatDate(entry.createdAt)} · ${Object.keys(proposalImageLabels).filter(slot => entry.snapshot.selections[slot]).length} 张方案图</time></div>
        <div class="actions"><a class="button flat button-sm" href="${versionUrl(entry.version, true)}" target="_blank" rel="noreferrer">预览</a>
        <a class="button secondary button-sm" href="${versionUrl(entry.version)}" download>下载 PDF</a></div></li>`).join('')}</ul>` :
      '<p class="empty">保存后可在这里下载各版 PDF。</p>'}</section>
    ${factoryNotice()}`;
}

function replies() {
  const complete = state.replies.filter(reply => reply.complete).length;
  return `${heading('采购回复测试', '用于模拟首次回复的可用性评估。')}
  <div class="split-layout"><section class="card pane"><h2>给测试参与者的任务</h2>
    <p>${state.project.isDemo ? '你负责一家酒店的采购，计划采购约 500 套。' : '假设你是这个项目的采购方。'}阅读提案后，写一封你会发送给供应商的首次回复。</p>
    ${state.versions.length ? `<a class="text-link" href="${versionUrl(state.versions[0].version, true)}" target="_blank" rel="noreferrer">阅读英文提案</a>` :
      '<p class="tiny">提案保存后可从这里打开。</p>'}
    <label for="reply-text">首次回复原文</label><textarea id="reply-text" rows="7" maxlength="8000" placeholder="在此填写首次回复…">${escape(drafts.reply || '')}</textarea>
    <div class="actions">${button('记录并统计', 'score', '', 'button primary')}</div>
  </section><section class="card pane"><div class="pane-title"><h2>测试记录</h2>${button(current.replySummary ? '隐藏统计' : '查看统计', 'reply-summary', '', 'button flat button-sm')}</div>
    ${current.replySummary && state.replies.length ? `<p class="reply-count">${complete} / ${state.replies.length} <span>首次回复信息完整</span></p>
      <ul class="jobs">${state.replies.map(reply => `<li><div><strong>${reply.complete ? '信息完整' : '信息有遗漏'}</strong>
        <span class="tiny">${formatDate(reply.createdAt)}${reply.missing?.length ? ` · 缺少 ${escape(reply.missing.map(key => fieldLabels[key] ?? key).join('、'))}` : ''}</span>
        <p>${escape(reply.input)}</p></div></li>`).join('')}</ul>` :
      (current.replySummary ? '<p class="empty">暂无测试记录。</p>' : '<p class="empty">首次回复完成后由评估员查看统计。</p>')}
  </section></div>`;
}

function openDialog(content) {
  query('#dialog-content').innerHTML = content;
  if (dialog.open) query('[autofocus]', dialog)?.focus();
  else dialog.showModal();
}

function dialogHead(title) {
  return `<div class="pane-title dialog-head"><h2 id="dialog-title">${escape(title)}</h2>
    ${button('关闭', 'close', 'aria-label="关闭对话框"', 'button flat button-sm')}</div>`;
}

function openModelSettings() {
  const sceneForm = dialog.open && query('#scene-form', dialog);
  const sceneDraft = sceneForm ? Object.fromEntries(new FormData(sceneForm)) : null;
  openDialog(`${dialogHead('模型设置')}
    <form id="model-settings-form" class="scene-form" autocomplete="off">
      <div><strong><span id="model-settings-name">百炼</span></strong>
        <p class="tiny" id="model-settings-status" role="status">正在读取配置…</p></div>
      <label>百炼 API Key
        <input name="apiKey" type="password" maxlength="512" autocomplete="new-password" spellcheck="false" required autofocus>
      </label>
      <p class="tiny">密钥保存在本机，供场景图和包装图使用。</p>
      <p class="tiny model-settings-error" role="alert" hidden></p>
      <div class="actions"><button type="submit" class="button primary" disabled>保存密钥</button></div>
    </form>`);
  const form = query('#model-settings-form', dialog);
  const input = form.elements.apiKey;
  const save = query('[type="submit"]', form);
  const closeButtons = dialog.querySelectorAll('[data-action="close"]');
  const status = query('#model-settings-status', form);
  const feedback = query('.model-settings-error', form);
  let loaded = false;
  const showConfig = config => {
    query('#model-settings-name', form).textContent = `百炼 · ${config.model}`;
    status.textContent = config.savedLocally ? '已保存在本机' : config.configured ? '当前服务已配置' : '待配置';
    if (state && (config.configured !== state.modelAvailable || config.configured !== state.sceneModelAvailable)) {
      state.modelAvailable = state.sceneModelAvailable = config.configured;
      render();
    }
  };
  dialog.addEventListener('close', () => {
    input.value = '';
    if (sceneDraft && route() === 'scenes' && !dialog.open) openSceneEditor(sceneDraft);
  }, { once: true });
  void request('/api/settings/model').then(config => {
    if (!dialog.open || !form.isConnected) return;
    loaded = true;
    save.disabled = false;
    showConfig(config);
  }).catch(() => {
    if (!dialog.open || !form.isConnected) return;
    status.textContent = '暂时无法读取模型设置，刷新页面后可重试。';
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!loaded || pending) return;
    const apiKey = input.value.trim();
    pending = true;
    input.disabled = save.disabled = true;
    for (const close of closeButtons) close.disabled = true;
    feedback.hidden = true;
    try {
      const config = await request('/api/settings/model', { apiKey });
      input.value = '';
      showConfig(config);
      showToast('密钥已保存。');
    } catch (error) {
      feedback.textContent = error.message;
      feedback.hidden = false;
    } finally {
      pending = false;
      input.disabled = save.disabled = false;
      for (const close of closeButtons) close.disabled = false;
      scheduleInquiry();
    }
  });
}

function printReferenceField(preferredId) {
  const { scenePrintMode } = state;
  if (scenePrintMode === 'plain') return '<p class="tiny">询盘要求无印花，使用当前商品主图。</p>';
  const references = ['A', 'B'].map(option => ({ option, item: asset(state.selected[`print${option}`]) }))
    .filter(reference => reference.item);
  const preferred = references.find(reference => reference.item.id === preferredId) ??
    references.find(reference => reference.option === current.print) ?? references[0];
  const required = scenePrintMode === 'required';
  return `<label>印花参考<select name="printAssetId" ${required ? 'required' : ''}>
    ${required ? '' : '<option value="">保留主图原样</option>'}
    ${references.map(({ item, option }) => `<option value="${item.id}" ${item.id === preferred?.item.id ? 'selected' : ''}>印花 ${option} · 当前选稿</option>`).join('')}
  </select></label>`;
}

function openSceneEditor(job) {
  const source = asset(state.selected.source);
  const presets = state.scenePresets ?? [];
  const use = state.buyer.use ?? '';
  const recommended = recommendedScene(use);
  const selected = job?.scene || recommended || (use ? 'custom' : '');
  const initialBrief = job?.brief ?? (selected === 'custom' ? use : '');
  const unresolved = state.jobs.some(item => item.slot === 'lifestyle' && item.status === 'needs_review');
  const missingPrint = missingScenePrint();
  const ready = Boolean(source && state.sceneModelAvailable && !missingPrint && !unresolved);
  openDialog(`${dialogHead('AI 生成场景图')}
    <form id="scene-form" class="scene-form">
      ${source ? `<div class="scene-reference"><div class="material-preview">${image(source.id)}</div><div><strong>当前商品主图</strong>
        <p class="tiny">${escape(state.kit.product?.nameZh ?? imageName(source))}</p></div></div>` : ''}
      <label>使用场景<select name="scene" required>
        <option value="">请选择场景</option>
        ${presets.map(item => `<option value="${escape(item.id)}" ${item.id === selected ? 'selected' : ''}>${escape(item.label)}${item.id === recommended ? ' · 询盘推荐' : ''}</option>`).join('')}
      </select></label>
      ${printReferenceField(job?.printAssetId)}
      <div class="scene-description">
        <label for="scene-brief">场景描述 <small class="tiny" id="scene-brief-hint"></small></label>
        <select id="scene-description-template" aria-label="选择描述模板"></select>
        <textarea id="scene-brief" name="brief" rows="3" maxlength="1500" placeholder="例如：自然窗光，浅色桌布，让杯碟成为画面主体。">${escape(initialBrief)}</textarea>
        <p class="tiny" id="scene-template-status" role="status">可直接手写，也可选择模板后继续修改。</p>
      </div>
      ${!source ? '<p class="hint">请先上传商品主图或从资料库选择商品。</p>' :
        missingPrint ? '<p class="hint">请先在「印花设计」选定印花方案。</p>' :
        !state.sceneModelAvailable ? '<p class="hint">保存百炼密钥后即可生成。</p>' :
        unresolved ? '<p class="hint">请先核对上一笔场景图任务。</p>' :
        '<p class="tiny">确认后会把所选参考图和场景描述提交给百炼，模型调用可能计费。</p>'}
      <div class="actions">${button('取消', 'close', '', 'button flat')}
        ${!state.sceneModelAvailable ? button('配置模型', 'model-settings', '', 'button primary') :
          `<button type="submit" class="button primary" ${ready ? '' : 'disabled'}>确认生成</button>`}</div>
    </form>`);
  const form = query('#scene-form', dialog);
  const scene = form.elements.scene;
  const brief = form.elements.brief;
  const template = query('#scene-description-template', form);
  const templateStatus = query('#scene-template-status', form);
  let descriptions;
  let lastTemplate;
  function updateDescriptionOptions() {
    brief.required = scene.value === 'custom';
    query('#scene-brief-hint', form).textContent = brief.required ? '自定义场景必填' : '选填';
    descriptions = [...(sceneDescriptionTemplates[scene.value] ?? []), ...sceneDescriptionTemplates.common];
    template.innerHTML = '<option value="">选择描述模板</option>' +
      descriptions.map(([label], index) => `<option value="${index}">${escape(label)}</option>`).join('');
  }
  updateDescriptionOptions();
  scene.addEventListener('change', updateDescriptionOptions);
  template.addEventListener('change', () => {
    if (template.value === '') return;
    const [label, text] = descriptions[Number(template.value)];
    const previous = brief.value === lastTemplate?.filled ? lastTemplate.previous : brief.value.trim();
    const filled = previous ? `${previous}\n${text}` : text;
    template.value = '';
    if (filled.length > brief.maxLength) {
      templateStatus.textContent = '场景描述最多 1500 字，请缩短内容后再添加模板。';
      return;
    }
    brief.value = filled;
    lastTemplate = { previous, filled };
    templateStatus.textContent = `已填入「${label}」，可继续修改。`;
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (pending || sceneGenerating || !ready) return;
    const values = Object.fromEntries(new FormData(form));
    const data = {
      ...values, printAssetId: values.printAssetId || null, sourceId: source.id, confirmed: true,
      requestId: crypto.randomUUID(),
    };
    const description = data.brief.trim();
    if (scene.value === 'custom' && !description) {
      brief.value = '';
      brief.reportValidity();
      return;
    }
    dialog.close();
    sceneGenerating = true;
    void perform(async () => {
      render();
      try { await request('/api/scenes', { ...data, brief: description }); }
      finally { sceneGenerating = false; }
    }, '场景图已生成，可选为提案封面。');
  });
}

function openSceneResolve(id) {
  openDialog(`${dialogHead('核对场景图任务')}<p>请在百炼控制台核对前次请求。核对后可重新生成场景图。</p>
    <div class="actions">${button('已核对，可重新生成', 'scene-resolve-confirm', `data-id="${id}"`, 'button primary')}</div>`);
}

function renderCatalogResults(container, picker = false) {
  const term = query('#catalog-query', container).value.trim().normalize('NFKC').toLowerCase();
  const matches = catalogProducts.filter(item => [item.sku, item.nameZh, item.nameEn].some(value =>
    value.normalize('NFKC').toLowerCase().includes(term)));
  query('#catalog-results', container).innerHTML = catalogCards(matches, { picker });
}

async function refreshCatalogPicker() {
  const result = query('#catalog-results', dialog);
  result.setAttribute('aria-busy', 'true');
  try {
    const { products } = await request('/api/catalog');
    if (dialog.open && result.isConnected) {
      catalogProducts = products;
      renderCatalogResults(dialog, true);
    }
  } catch (error) {
    if (dialog.open && result.isConnected) result.textContent = error.message;
  } finally {
    result.setAttribute('aria-busy', 'false');
  }
}

function openCatalogPicker() {
  openDialog(catalogPicker(dialogHead));
  return refreshCatalogPicker();
}

function openCatalogEditor(item) {
  openDialog(catalogForm(dialogHead, item));
  const form = query('#catalog-form', dialog);
  const feedback = query('#catalog-form-error', form);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    const { image, ...fields } = Object.fromEntries(new FormData(form));
    const controls = dialog.querySelectorAll('button, input');
    for (const control of controls) control.disabled = true;
    feedback.hidden = true;
    try {
      await perform(async () => {
        if (image.size) fields.image = await fileData(image);
        const path = item ? `/api/catalog/${encodeURIComponent(item.id)}` : '/api/catalog';
        const { product } = await request(path, { ...fields, revision: item?.revision });
        catalogProducts = item ? catalogProducts.map(entry => entry.id === item.id ? product : entry) :
          [product, ...catalogProducts];
        dialog.close();
      }, '商品资料已保存。', error => {
        feedback.textContent = error.message;
        feedback.hidden = false;
      });
    } finally {
      for (const control of controls) control.disabled = false;
    }
  });
}

function useCatalogProduct(target) {
  const item = catalogProducts.find(product => product.id === target.dataset.id);
  if (!item) return;
  const close = dialog.querySelector('[data-action="close"]');
  target.disabled = close.disabled = true;
  return perform(async () => {
    await request('/api/product/from-library', { libraryId: item.id, libraryRevision: item.revision });
    drafts.product = null;
    dialog.close();
  }, '已带入商品资料和主图。', async error => {
    target.disabled = close.disabled = false;
    showToast(error.message, true);
    if (error.status === 409 && dialog.open) await refreshCatalogPicker();
  });
}

const defaultCutoutTolerance = 18;
const colorHex = rgb => '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('');
const colorRgb = hex => [1, 3, 5].map(start => Number.parseInt(hex.slice(start, start + 2), 16));

async function importArtwork(file, input) {
  const attempt = ++lastArtworkImport;
  let bitmap;
  try {
    const artwork = await decodeArtwork(file);
    bitmap = artwork.bitmap;
    if (attempt !== lastArtworkImport || !input.isConnected || dialog.open) {
      bitmap.close();
      return;
    }
    openArtworkEditor(file, artwork);
  } catch (error) {
    bitmap?.close();
    if (attempt === lastArtworkImport && input.isConnected) showToast(error.message, true);
  }
}

function openArtworkEditor(file, { bitmap, isPng }) {
  openDialog(`${dialogHead('处理印花素材')}
    <form id="artwork-import-form">
      <div class="cutout-previews">
        <figure><figcaption>原图</figcaption><div class="cutout-stage">
          <canvas id="cutout-original" role="img" aria-label="印花原图"></canvas></div></figure>
        <figure><figcaption>处理预览</figcaption><div class="cutout-stage">
          <canvas id="cutout-preview" role="img" aria-label="印花处理预览"></canvas></div></figure>
      </div>
      <div class="cutout-controls">
        <label class="checkbox"><input type="checkbox" name="remove">去除背景</label>
        <label>背景颜色<input type="color" name="color"></label>
        <label class="cutout-tolerance">容差<input type="range" name="tolerance" min="0" max="100" value="${defaultCutoutTolerance}"><output></output></label>
      </div>
      <p class="tiny">纯色或接近纯色的背景效果更好。可点击原图取色，调节容差后确认预览。</p>
      <p class="tiny cutout-status" id="cutout-status" role="status"></p>
      <div class="actions">${button('取消', 'close', '', 'button flat')}<button type="submit" class="button primary">保存印花素材</button></div>
    </form>`);
  const form = query('#artwork-import-form', dialog);
  dialog.addEventListener('close', () => {
    bitmap.close();
    if (form.isConnected && !dialog.open) query('#dialog-content').replaceChildren();
  }, { once: true });

  const original = query('#cutout-original', form);
  const preview = query('#cutout-preview', form);
  const originalContext = drawArtworkImage(original, bitmap, 700);
  const source = originalContext.getImageData(0, 0, original.width, original.height);
  preview.width = original.width;
  preview.height = original.height;
  const context = preview.getContext('2d');
  const pixels = context.createImageData(preview.width, preview.height);
  const { remove, color, tolerance } = form.elements;
  const output = query('output', form);
  const save = query('[type="submit"]', form);
  const status = query('#cutout-status', form);
  const suggested = suggestArtworkBackground(source);
  const transparent = hasArtworkTransparency(source);
  const sourceHasForeground = source.data.some((value, index) => index % 4 === 3 && value > 0);
  remove.checked = Boolean(suggested) && !transparent;
  color.value = colorHex(suggested ?? [255, 255, 255]);
  const settings = () => remove.checked ? { color: colorRgb(color.value), tolerance: Number(tolerance.value) } : null;

  function updatePreview() {
    const options = settings();
    const result = options
      ? removeArtworkBackground(source, options.color, options.tolerance, pixels.data)
      : { hasForeground: sourceHasForeground, changed: true };
    context.putImageData(options ? pixels : source, 0, 0);
    color.disabled = tolerance.disabled = !options;
    output.value = tolerance.value;
    save.disabled = !result.hasForeground || !result.changed;
    status.textContent = !result.hasForeground ? '预览中没有图案。请降低容差或保留原图。' :
      !result.changed ? '未找到匹配的背景颜色。请重新取色或提高容差。' :
      options ? '棋盘格表示透明区域。确认图案完整后保存。' :
      transparent ? '已保留原有透明区域。' :
      '将按原图保存。可勾选「去除背景」处理。';
  }

  form.addEventListener('input', updatePreview);
  original.addEventListener('click', event => {
    const bounds = original.getBoundingClientRect();
    const x = Math.min(source.width - 1, Math.floor((event.clientX - bounds.left) * source.width / bounds.width));
    const y = Math.min(source.height - 1, Math.floor((event.clientY - bounds.top) * source.height / bounds.height));
    const index = (y * source.width + x) * 4;
    if (!source.data[index + 3]) return;
    color.value = colorHex(Array.from(source.data.subarray(index, index + 3)));
    remove.checked = true;
    updatePreview();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || save.disabled) return;
    const options = settings();
    const title = file.name.replace(/\.[^.]+$/, '').trim() || '印花素材';
    const filename = title.slice(0, 236) + '.png';
    const controls = dialog.querySelectorAll('button, input');
    for (const control of controls) control.disabled = true;
    status.textContent = '正在保存印花素材…';
    let failure;
    await perform(async () => {
      const image = await artworkImageData(file, bitmap, isPng, options);
      await request('/api/product/images/artwork', { image, filename });
      dialog.close();
    }, '印花素材已保存。', error => { failure = error.message; });
    if (failure && dialog.open) {
      for (const control of controls) control.disabled = false;
      updatePreview();
      status.textContent = failure;
    }
  });
  updatePreview();
}

function openProjectForm() {
  openDialog(projectFormMarkup(dialogHead));
  const form = query('#project-new-form', dialog);
  const fields = query('.project-template', form);
  const errorMessage = query('#project-new-error', form);
  let previousValues;
  let requestId;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    const data = Object.fromEntries(new FormData(form));
    data.name = data.name.trim();
    data.customer = data.customer.trim();
    if (!data.name) {
      errorMessage.textContent = '请填写项目名称。';
      errorMessage.hidden = false;
      form.elements.name.focus();
      return;
    }
    const values = JSON.stringify(data);
    if (values !== previousValues) requestId = crypto.randomUUID();
    previousValues = values;
    pending = true;
    for (const input of form.querySelectorAll('input, button')) input.disabled = true;
    query('.dialog-head button', dialog).disabled = true;
    fields.disabled = true;
    errorMessage.hidden = true;
    try {
      const { project } = await request('/api/projects', { ...data, requestId });
      location.assign(`/?project=${encodeURIComponent(project.id)}#inquiry`);
    } catch (error) {
      errorMessage.textContent = error.message;
      errorMessage.hidden = false;
      for (const input of form.querySelectorAll('input, button')) input.disabled = false;
      query('.dialog-head button', dialog).disabled = false;
      fields.disabled = false;
      pending = false;
    }
  });
}

const packageLines = value => [...new Set(value.split('\n').map(line => line.trim()).filter(Boolean))];
const matchingKey = (labels, value) => Object.keys(labels).find(key => labels[key] === value) ?? value;

function packageConfirmationOptions(choices, selected = '') {
  return `<option value="">待客户确认</option>${choices.map(choice =>
    `<option value="${escape(choice)}" ${choice === selected ? 'selected' : ''}>${escape(choice)}</option>`).join('')}`;
}

function openInquiryEditor() {
  const { ready, result } = inquiryAdoption();
  if (!ready) return;
  const revision = state.revision;
  const text = inquiryText();
  const choices = (result.packaging ?? []).map(value => labelFor(packagingLabels, value));
  const confirmed = result.packagingConfirmed && choices.length === 1 ? choices[0] : '';
  const values = {
    use: labelFor(useLabels, result.use) ?? '',
    quantity: result.quantity == null ? '' : String(result.quantity),
    quantityQualifier: labelFor(qtyLabel, result.quantityQualifier) ?? '',
    sku: result.sku ?? '',
    print: labelFor(printLabels, result.print) ?? '',
  };
  const input = (name, attributes = '') => `<input name="${name}" value="${escape(values[name])}" ${attributes}>`;
  openDialog(`${dialogHead('编辑提取结果')}
    <p class="hint">原文引述会保留。保存后，采用或继续方案时会使用修正后的信息。</p>
    <form id="inquiry-review-form" aria-label="编辑提取结果">
      <div class="inquiry-review-fields">
        <label>使用场景${input('use', 'maxlength="120"')}</label>
        <label>数量${input('quantity', 'type="number" min="1" max="9007199254740991" step="1" inputmode="numeric" placeholder="待确认可留空"')}</label>
        <label>数量说明${input('quantityQualifier', 'maxlength="80" placeholder="例如首批约数"')}</label>
        <label>货号${input('sku', 'maxlength="48"')}</label>
        <label class="inquiry-review-wide">印花要求${input('print', 'maxlength="240"')}</label>
        <label class="inquiry-review-wide">包装要求<textarea name="packaging" rows="2" maxlength="1460" placeholder="每行填写一个包装选项">
${escape(choices.join('\n'))}</textarea><small class="tiny">每行一个选项。</small></label>
        <label class="inquiry-review-wide">客户确认的包装<select name="confirmedPackage">
          ${packageConfirmationOptions(choices, confirmed)}</select></label>
      </div>
      <p id="inquiry-review-error" class="inquiry-review-error" role="alert" hidden></p>
      <div class="actions">${button('取消', 'close', '', 'button flat')}<button type="submit" class="button primary">保存修改</button></div>
    </form>`);

  const form = query('#inquiry-review-form', dialog);
  const packaging = form.elements.namedItem('packaging');
  const confirmation = form.elements.namedItem('confirmedPackage');
  const save = query('[type="submit"]', form);
  const feedback = query('#inquiry-review-error', form);
  const setError = message => {
    feedback.textContent = message;
    feedback.hidden = !message;
  };
  packaging.addEventListener('input', () => {
    const options = packageLines(packaging.value);
    const shown = [...confirmation.options].slice(1).map(option => option.value);
    if (options.join('\n') !== shown.join('\n')) confirmation.innerHTML = packageConfirmationOptions(options);
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    if (route() !== 'inquiry' || inquiryText() !== text || state.revision !== revision) {
      setError('询盘已有更新，请关闭后重新打开编辑。');
      return;
    }
    const fields = {};
    for (const [name, before] of Object.entries(values)) {
      const value = form.elements.namedItem(name).value.trim();
      if (value === before) continue;
      fields[name] = value === '' ? null : name === 'quantity' ? Number(value) : name === 'print' ? matchingKey(printLabels, value) : value;
    }
    const chosen = confirmation.value;
    const options = chosen ? [chosen] : packageLines(packaging.value);
    if (options.join('\n') !== choices.join('\n')) fields.packaging = options.map(value => matchingKey(packagingLabels, value));
    if (chosen !== confirmed || (chosen && Object.hasOwn(fields, 'packaging'))) fields.packagingConfirmed = Boolean(chosen);
    if (!Object.keys(fields).length) {
      dialog.close();
      return;
    }
    setError('');
    save.disabled = true;
    try {
      await perform(async () => {
        await request('/api/inquiry/review', { revision, fields });
        if (dialog.open && form.isConnected) dialog.close();
      }, '提取结果已保存。', error => {
        const message = error.status === 409 ? '询盘已有更新，请关闭后重新打开编辑。' : error.message;
        if (dialog.open && form.isConnected) setError(message);
        else showToast(message, true);
      });
    } finally {
      save.disabled = false;
    }
  });
}

function openAsset(id) {
  const item = asset(id);
  if (!item) return;
  openDialog(`${dialogHead(imageName(item))}<div class="dialog-image">${image(id)}</div>
    <p class="tiny">${escape(kindNames[item.kind])}${item.notes ? ` · ${escape(item.notes)}` : ''}</p>`);
}

function openReview(id) {
  const item = asset(id);
  if (!item) return;
  const option = item.slot.at(-1);
  const checked = state.packing[option].reviewed[id] === 'approved';
  openDialog(`${dialogHead(`审核 ${imageName(item)}`)}<div class="dialog-image review-image">${image(id)}</div>
    <fieldset id="checklist"><legend>视觉审核项</legend>
      ${(isBlank() ? customReviewLabels : reviewLabels).map(label => `<label class="checkbox"><input type="checkbox" ${checked ? 'checked' : ''}>${label}</label>`).join('')}
    </fieldset>
    <p class="tiny">此处只记录视觉审核。工厂生产确认继续保留为待确认。</p>
    <div class="actions">${button('标记需重做', 'review-reject', `data-id="${id}" data-option="${option}"`, 'button secondary')}
    ${button('视觉审核通过', 'review-save', `data-id="${id}" data-option="${option}"`, 'button primary')}</div>`);
}

async function perform(operation, message, onError) {
  if (pending) return;
  pending = true;
  main.setAttribute('aria-busy', 'true');
  refreshInquiryResults();
  try {
    await operation();
    render();
    showToast(message);
  } catch (error) {
    if (error.status) {
      try {
        if (libraryPage) ({ products: catalogProducts } = await request('/api/catalog'));
        else state = await request('/api/workspace');
        render();
      }
      catch { /* Preserve the last visible draft while displaying the request failure. */ }
    }
    if (onError) await onError(error);
    else showToast(error.message, true);
  } finally {
    pending = false;
    main.removeAttribute('aria-busy');
    refreshInquiryResults();
    scheduleInquiry();
  }
}

async function saveLocalPack() {
  const option = current.pack;
  const baseId = query('#pack-base').value;
  const treatment = query('#pack-treatment').value;
  const brief = drafts[option];
  const id = crypto.randomUUID();
  let image;
  let failure;
  try { image = await packagingAdjustment(baseId, option, treatment); }
  catch (error) { failure = error.message; }
  await request(`/api/packaging/${option}`, { mode: 'local', baseId, treatment, brief, requestId: id, image, failure });
}

function generatePackModel({ option, ...input }) {
  dialog.close();
  generatingPack = option;
  return perform(async () => {
    try {
      render();
      await request(`/api/packaging/${option}`, {
        ...input, mode: 'model', confirmed: true, requestId: crypto.randomUUID(),
      });
    } finally {
      generatingPack = null;
    }
  }, '包装图已生成，可审核后选入提案。');
}

function openCustomPackModel() {
  const option = current.pack;
  const source = asset(state.selected.source);
  const brief = drafts[option].trim();
  if (!source || !state.modelAvailable || missingScenePrint()) return;
  openDialog(`${dialogHead('AI 生成包装图')}
    <form id="pack-model-form" class="scene-form">
      <div class="scene-reference"><div class="material-preview">${image(source.id)}</div><div><strong>当前商品主图</strong>
        <p class="tiny">${escape(state.kit.product?.nameZh ?? imageName(source))}</p></div></div>
      <p><strong>${packOptionLabels[option]}</strong></p>
      ${printReferenceField()}
      ${brief ? `<div><strong>包装要求</strong><p class="tiny">${escape(brief)}</p></div>` : ''}
      <p class="tiny">确认后会把主图、选用的印花和包装要求提交给百炼，模型调用可能计费。</p>
      <div class="actions">${button('取消', 'close', '', 'button flat')}
        <button type="submit" class="button primary">确认生成</button></div>
    </form>`);
  const form = query('#pack-model-form', dialog);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (pending) return;
    const printAssetId = new FormData(form).get('printAssetId') || null;
    void generatePackModel({ option, sourceId: source.id, printAssetId, brief });
  });
}

function modelDialog() {
  if (isBlank()) return openCustomPackModel();
  const option = current.pack;
  current.modelPrompt = { option, brief: drafts[option], baseId: query('#pack-base').value, printAssetId: query('#pack-print-guide')?.value || null };
  openDialog(`${dialogHead(`提交 Pack ${option} 模型生成`)}
    <p>百炼将接收商品底图、包装视觉与结构参考、透明原稿及你指定的印花图。模型调用可能计费。</p>
    <div class="actions">${button('返回', 'close', '', 'button flat')}
    ${button('确认提交', 'pack-model-submit', '', 'button primary')}</div>`);
}

const actions = {
  'model-settings': openModelSettings,
  'project-new': openProjectForm,
  'catalog-new': () => openCatalogEditor(null),
  'catalog-edit': target => {
    const item = catalogProducts.find(product => product.id === target.dataset.id);
    if (item) openCatalogEditor(item);
  },
  'catalog-pick': openCatalogPicker,
  'catalog-use': useCatalogProduct,
  'scene-new': () => openSceneEditor(),
  'scene-retry': target => openSceneEditor(state.jobs.find(job => job.id === target.dataset.id)),
  'job-refresh': () => perform(async () => { state = await request('/api/workspace'); }, '已刷新生成状态。'),
  'scene-resolve': target => openSceneResolve(target.dataset.id),
  'scene-resolve-confirm': target => {
    dialog.close();
    return perform(() => request('/api/scenes/resolve', { requestId: target.dataset.id, providerChecked: true }), '已记录任务核对。');
  },
  'product-upload': target => query(`#product-file-${target.dataset.slot}`).click(),
  'inquiry-upload': () => query('#inquiry-file').click(),
  'inquiry-edit': openInquiryEditor,
  'inquiry-retry': () => {
    inquiryError = '';
    refreshInquiryResults();
    return extractInquiryDraft();
  },
  'inquiry-continue': () => {
    const next = inquiryNext(inquiryAdoption());
    if (!next?.ready) return;
    const text = inquiryText();
    return perform(async () => {
      const buyer = await request('/api/inquiry/continue', {});
      if (route() !== 'inquiry' || inquiryText() !== text) return;
      if (buyer.packaging.length) current.pack = suggestedPack(buyer.packaging);
      if (buyer.print) current.print = buyer.print === 'print-b' ? 'B' : 'A';
      location.hash = next.page;
    }, '已带入本次询盘。');
  },
  buyer: () => {
    const adoption = inquiryAdoption();
    if (adoption.enabled) return perform(() => request('/api/buyer', {}), `已将${adoption.fields}带入提案。`);
  },
  score: () => perform(async () => {
    await request('/api/replies', { text: drafts.reply ?? query('#reply-text').value });
    drafts.reply = '';
  }, '首次回复已记录。'),
  'reply-summary': () => { current.replySummary = !current.replySummary; render(); },
  image: target => openAsset(target.dataset.id),
  close: () => dialog.close(),
  'print-tab': target => { current.print = target.dataset.option; render(); },
  'pack-tab': target => { current.pack = target.dataset.option; render(); },
  'print-reset': () => {
    if (!activeArtwork) return;
    Object.assign(current.revision[current.print], state.kit.print.options.find(item => item.id === `print-${current.print.toLowerCase()}`));
    activeArtwork.draw();
  },
  'print-save': () => perform(() => request(`/api/prints/${current.print}`, {
    position: current.revision[current.print], image: activeArtwork.exportImage(),
  }), '贴图候选已保存，可手动选入提案。'),
  'pack-local': () => perform(saveLocalPack, '包装候选已生成，等待视觉审核。'),
  'pack-upload': () => query('#pack-file').click(),
  'pack-model': () => modelDialog(),
  'pack-model-submit': () => generatePackModel(current.modelPrompt),
  review: target => openReview(target.dataset.id),
  'review-save': target => {
    const unchecked = dialog.querySelector('#checklist input:not(:checked)');
    if (unchecked) {
      unchecked.required = true;
      unchecked.reportValidity();
      return;
    }
    dialog.close();
    return perform(() => request(`/api/packaging/${target.dataset.option}/review`, { assetId: target.dataset.id, status: 'approved', checked: true }), '视觉审核通过，可选入提案。');
  },
  'review-reject': target => {
    dialog.close();
    return perform(() => request(`/api/packaging/${target.dataset.option}/review`, { assetId: target.dataset.id, status: 'rejected' }), '已标记需要重做。');
  },
  select: target => perform(() => request('/api/select', { slot: target.dataset.slot, assetId: target.dataset.id }),
    target.dataset.slot === 'lifestyle' ? '已设为提案封面。' : '已更新提案选稿。'),
  retry: target => {
    drafts[current.pack] = state.jobs.find(job => job.id === target.dataset.id)?.brief ?? '';
    query('#pack-brief').value = drafts[current.pack];
    query('#pack-brief').focus();
  },
  'job-resolve': target => openDialog(`${dialogHead('核对模型请求')}<p>请先在百炼控制台确认前次请求结果，再允许重新提交。</p>
    <div class="actions">${button('已核对并允许重试', 'job-resolve-confirm', `data-id="${target.dataset.id}"`, 'button primary')}</div>`),
  'job-resolve-confirm': target => {
    dialog.close();
    return perform(() => request(`/api/packaging/${current.pack}/resolve`, { requestId: target.dataset.id, providerChecked: true }), '已记录人工核对。');
  },
  'save-version': () => perform(() => request('/api/versions', { requestId: crypto.randomUUID() }), '英文 PDF 已保存，可在版本列表下载。'),
};

document.addEventListener('click', event => {
  const target = event.target.closest('button[data-action]');
  if (target && !target.disabled && (!pending || ['close', 'image'].includes(target.dataset.action))) {
    actions[target.dataset.action]?.(target);
  }
  if (event.target === dialog && !pending) dialog.close();
});

query('.skip').addEventListener('click', event => {
  event.preventDefault();
  main.focus();
});

main.addEventListener('keydown', event => {
  const tab = event.target.closest('.workspace-tab');
  if (!tab || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const tabs = [...tab.closest('.workspace-tabs').querySelectorAll('.workspace-tab')];
  const index = tabs.indexOf(tab);
  const next = {
    ArrowLeft: tabs[(index + tabs.length - 1) % tabs.length],
    ArrowRight: tabs[(index + 1) % tabs.length],
    Home: tabs[0],
    End: tabs.at(-1),
    ' ': tab,
  }[event.key];
  if (!next) return;
  event.preventDefault();
  next.focus({ preventScroll: true });
  revealWorkspaceTab(next);
  next.click();
});

dialog.addEventListener('cancel', event => {
  if (pending && (projectList || query('#artwork-import-form, #catalog-form, #catalog-results, #model-settings-form', dialog))) event.preventDefault();
});

document.addEventListener('submit', event => {
  if (event.target.id !== 'product-form') return;
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.target));
  void perform(async () => {
    await request('/api/product', fields);
    drafts.product = null;
  }, '商品信息已保存。');
});

document.addEventListener('input', event => {
  const target = event.target;
  if (target.id === 'catalog-query') {
    const picker = dialog.contains(target);
    const container = picker ? dialog : main;
    if (query('#catalog-results', container).getAttribute('aria-busy') !== 'true') renderCatalogResults(container, picker);
  }
  if (target.id === 'inquiry-text') updateInquiryDraft(target.value);
  if (target.id === 'reply-text') drafts.reply = target.value;
  if (target.id === 'pack-brief') drafts[current.pack] = target.value;
  if (target.form?.id === 'product-form') drafts.product = Object.fromEntries(new FormData(target.form));
});

document.addEventListener('compositionstart', event => {
  if (event.target.id !== 'inquiry-text') return;
  inquiryComposing = true;
  clearTimeout(inquiryTimer);
  refreshInquiryResults();
});

document.addEventListener('compositionend', event => {
  if (event.target.id !== 'inquiry-text') return;
  inquiryComposing = false;
  updateInquiryDraft(event.target.value);
});

document.addEventListener('change', event => {
  const target = event.target;
  if (target.id === 'inquiry-file' && target.files[0]) {
    const file = target.files[0];
    target.value = '';
    void importInquiryFile(file);
  }
  if (target.id === 'pack-file' && target.files[0]) {
    const file = target.files[0];
    const option = current.pack;
    perform(async () => {
      const image = await fileData(file);
      await request(`/api/packaging/${option}`, { mode: 'upload', requestId: crypto.randomUUID(), brief: drafts[option], image });
    }, '包装候选已导入，等待视觉审核。');
  }
  if (target.dataset.productImage && target.files[0]) {
    const file = target.files[0];
    const slot = target.dataset.productImage;
    target.value = '';
    if (slot === 'artwork') {
      void importArtwork(file, target);
      return;
    }
    void perform(async () => {
      const image = await fileData(file);
      await request(`/api/product/images/${slot}`, { image, filename: file.name });
    }, '图片已保存。');
  }
  if (target.dataset.selectSlot) {
    perform(() => request('/api/select', { slot: target.dataset.selectSlot, assetId: target.value || null }), '已更新提案选稿。');
  }
});

addEventListener('hashchange', () => {
  const panel = query('#workspace-panel');
  if (!panel) return;
  const id = route();
  if (id !== 'replies') current.replySummary = false;
  if (id !== 'inquiry') {
    clearTimeout(inquiryTimer);
    inquiryComposing = false;
  }
  if (panel.getAttribute('aria-labelledby') !== `tab-${id}`) render();
});

query(`.navigation a[href="${libraryPage ? '/library' : '/'}"]`).setAttribute('aria-current',
  libraryPage || projectList ? 'page' : 'location');

try {
  if (projectList || libraryPage) {
    if (libraryPage) ({ products: catalogProducts } = await request('/api/catalog'));
    else ({ projects } = await request('/api/projects'));
    addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  } else {
    state = await request('/api/workspace');
    if (state.buyer.packaging?.length) current.pack = suggestedPack(state.buyer.packaging);
    if (state.buyer.print === 'print-b') current.print = 'B';
  }
  mountWorkspace();
} catch (error) {
  main.innerHTML = `<div class="card pane"><h1>工作台暂未打开</h1><p>${escape(error.message)}</p>
    <div class="actions"><a class="button secondary" href="/">返回项目列表</a></div></div>`;
}

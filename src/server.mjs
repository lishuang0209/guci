import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { extractInquiry, scoreBuyerReply } from './inquiry.mjs';
import { acceptedInquiryQuantity, effectiveInquiry, reviewInquiry } from './inquiry-review.mjs';
import { readInquiryUpload } from './inquiry-upload.mjs';
import { kit, readKit, root } from './kit.mjs';
import { createProposalPdf } from './proposal-pdf.mjs';
import { generateCustomPackagingImage, generatePackagingImage, generateSceneImage } from './packaging-provider.mjs';
import { scenePresets } from './scene-presets.mjs';
import { Catalog } from './catalog.mjs';
import { ModelSettings } from './model-settings.mjs';
import { Projects } from './projects.mjs';
import { Workspace, WorkspaceError } from './store.mjs';

const assetLimit = 12 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identifier = /^[a-z0-9-]{1,64}$/i;
const productionLabel = '展示用视觉稿。实际尺寸、印花范围及内托适配待工厂确认。';
const scenePresetOptions = Object.entries(scenePresets).map(([id, { label }]) => ({ id, label }));
const generatedPreviewSlots = ['lifestyle', 'packA', 'packB'];
const blankPrint = {
  editableArea: { x: 0, y: 0, width: 1, height: 1 },
  options: kit.print.options,
};
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/library', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/images.mjs', ['images.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/artwork.mjs', ['artwork.mjs', 'text/javascript; charset=utf-8']],
  ['/artwork-cutout.mjs', ['artwork-cutout.mjs', 'text/javascript; charset=utf-8']],
  ['/projects.mjs', ['projects.mjs', 'text/javascript; charset=utf-8']],
  ['/projects.css', ['projects.css', 'text/css; charset=utf-8']],
  ['/catalog.mjs', ['catalog.mjs', 'text/javascript; charset=utf-8']],
  ['/catalog.css', ['catalog.css', 'text/css; charset=utf-8']],
]);

function fail(status, message) {
  throw new WorkspaceError(status, message);
}

function field(value, label, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
    fail(422, `${label}需为${required ? '非空，且' : ''}不超过 ${max} 字符的文本。`);
  }
  return value;
}

function productDetails(body) {
  return {
    sku: field(body.sku, '货号', 48).trim(),
    nameZh: field(body.nameZh, '商品名称', 120).trim(),
    nameEn: field(body.nameEn ?? '', '英文名称', 120, false).trim(),
  };
}

function requestId(value) {
  if (typeof value !== 'string' || !uuid.test(value)) fail(422, '请求编号无效。');
  return value;
}

function validPosition(position, area) {
  const { centerX, centerY, widthRatio, rotationDegrees } = position ?? {};
  if (![centerX, centerY, widthRatio, rotationDegrees].every(Number.isFinite) ||
      centerX < area.x || centerX > area.x + area.width ||
      centerY < area.y || centerY > area.y + area.height ||
      widthRatio < 0.07 || widthRatio > 0.42 || Math.abs(rotationDegrees) > 180) {
    fail(422, '印花中心、缩放或旋转超出可编辑范围。');
  }
  return { centerX, centerY, widthRatio, rotationDegrees };
}

function imageType(bytes) {
  if (bytes.length < 24 || bytes.length > assetLimit) fail(422, '图片大小不符合要求，单张上限 12 MB。');
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
      bytes.toString('ascii', 12, 16) === 'IHDR' &&
      bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 5000 &&
      bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 5000 &&
      bytes.subarray(-8).equals(Buffer.from('49454e44ae426082', 'hex'))) {
    return 'image/png';
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 &&
      bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'image/jpeg';
  fail(422, '请提供完整的 PNG 或 JPEG 图片。');
}

function upload(input) {
  if (typeof input !== 'string' || input.length > Math.ceil(assetLimit / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(input) || input.length % 4) fail(422, '图片数据缺失或格式无效。');
  const bytes = Buffer.from(input, 'base64');
  return { bytes, mimeType: imageType(bytes) };
}

function newAsset({ slot, kind, label, notes, mimeType, position, providerRequestId }) {
  const id = randomUUID();
  return { id, slot, kind, label, notes, mimeType, position, providerRequestId,
    createdAt: new Date().toISOString(), filename: `${id}.${mimeType === 'image/png' ? 'png' : 'jpg'}` };
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') fail(415, '请使用 JSON 请求。');
  const chunks = [];
  let size = 0;
  const limit = Math.ceil(assetLimit / 3) * 4 + 16000;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      fail(413, '请求内容过大。');
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch {
    fail(400, '请求内容不是有效 JSON 对象。');
  }
}

function send(res, status, body, headers = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Length': bytes.length,
    ...headers,
  });
  res.end(bytes);
}

const selectedPrint = (id, state) => id === state.selected.printA || id === state.selected.printB;
const projectProduct = (workspace, state) => workspace.hasTemplate ? kit.product : state.product;

function printModeForBuyer(print) {
  const value = (print ?? '').normalize('NFKC').toLowerCase().trim()
    .replace(/[\s-]+/g, ' ').replace(/[.!。！]+$/u, '').trim();
  if (!value) return 'optional';
  const plain = /^(?:plain white(?: (?:cups?|mugs?))?|unprinted(?: (?:white )?(?:cups?|mugs?))?|(?:no|without) (?:print|printing)|(?:白瓷)?(?:无|不|不要)印花|纯白(?:色)?(?:不印花?|无印花)?)$/u;
  return plain.test(value) ? 'plain' : 'required';
}

function modelPreviewIsCurrent(asset, state, product) {
  if (!asset?.sourceId || asset.kind !== 'model_preview' || !generatedPreviewSlots.includes(asset.slot)) return true;
  const printMode = printModeForBuyer(state.buyer.print);
  return asset.sourceId === state.selected.source &&
    (!asset.productSku || asset.productSku === product?.sku) &&
    (printMode !== 'required' || Boolean(asset.printAssetId)) &&
    (printMode !== 'plain' || !asset.printAssetId) &&
    (!asset.printAssetId || selectedPrint(asset.printAssetId, state));
}

function clearOutdatedSelectedPreviews(workspace, state) {
  const product = projectProduct(workspace, state);
  for (const slot of generatedPreviewSlots) {
    const id = state.selected[slot];
    if (id && !modelPreviewIsCurrent(workspace.asset(id, slot), state, product)) state.selected[slot] = null;
  }
}

function view(workspace, project, modelAvailable) {
  const state = workspace.state();
  const hasTemplate = workspace.hasTemplate;
  const product = projectProduct(workspace, state);
  const selected = { ...state.selected };
  const assets = workspace.assets().map(asset => {
    if (modelPreviewIsCurrent(asset, state, product)) return asset;
    if (selected[asset.slot] === asset.id) selected[asset.slot] = null;
    const staleField = asset.slot === 'lifestyle' ? 'sceneStale' : 'packStale';
    return { ...asset, [staleField]: true };
  });
  return {
    ...state, project, artworkId: hasTemplate ? 'lemon-original' : state.artworkId,
    selected,
    kit: {
      product, print: hasTemplate ? kit.print : blankPrint,
      packPresets: hasTemplate ? kit.packPresets : {},
      factory: hasTemplate ? kit.factory : null,
      demo: hasTemplate ? kit.demo : null, cases: hasTemplate ? kit.cases : [],
    },
    assets, jobs: workspace.jobs().map(job =>
      job.status === 'running' && !workspace.runningJobs.has(job.id) ? { ...job, status: 'needs_review' } : job),
    versions: workspace.versions(), modelAvailable,
    sceneModelAvailable: modelAvailable, scenePresets: scenePresetOptions,
    scenePrintMode: printModeForBuyer(state.buyer.print),
  };
}

function currentProductReferences(workspace, body, subject) {
  const state = workspace.state();
  if (body.revision !== state.revision) fail(409, '工作台已有更新。已刷新数据，请重新操作。');
  if (!state.selected.source) fail(422, '请先在「商品资料」上传或选用商品主图。');
  const sourceId = field(body.sourceId, '商品主图', 64);
  if (sourceId !== state.selected.source) fail(409, '商品主图已更换，请重新检查生成素材。');
  const source = workspace.asset(sourceId, 'source');
  const printAssetId = body.printAssetId == null ? null : field(body.printAssetId, '印花选稿', 64);
  const printMode = printModeForBuyer(state.buyer.print);
  if (printMode === 'required' && !printAssetId) {
    fail(422, `此项目有印花要求，请先在「印花设计」选入印花稿，再选择它生成${subject}。`);
  }
  if (printMode === 'plain' && printAssetId) fail(422, `此项目要求无印花，请使用商品主图生成${subject}。`);
  const references = [{ role: 'product', bytes: workspace.load(source), mimeType: source.mimeType }];
  if (printAssetId) {
    if (!selectedPrint(printAssetId, state)) fail(422, `${subject}只能引用当前已选中的印花稿。`);
    const print = workspace.asset(printAssetId);
    if (!['printA', 'printB'].includes(print.slot)) fail(422, `${subject}只能引用当前已选中的印花稿。`);
    references.push({ role: 'approved-print', bytes: workspace.load(print), mimeType: print.mimeType });
  }
  return { references, provenance: { sourceId, printAssetId, productSku: projectProduct(workspace, state)?.sku ?? null } };
}

async function packageImage(workspace, option, body, apiKey, fetcher) {
  const mode = body.mode;
  if (!['local', 'upload', 'model'].includes(mode)) fail(422, '请选择生成或导入方式。');
  if (mode === 'model' && (!apiKey || body.confirmed !== true)) fail(422, '请先配置模型密钥，并确认本次模型提交。');
  const id = requestId(body.requestId);
  const slot = `pack${option}`;
  const brief = field(body.brief ?? '', '包装改稿要求', 1500, false).trim();
  const custom = mode === 'model' && !workspace.hasTemplate ? currentProductReferences(workspace, body, '包装图') : null;
  const job = { id, slot, mode, brief, ...custom?.provenance, createdAt: new Date().toISOString() };
  workspace.claimJob(job);
  workspace.runningJobs.add(id);
  let providerResult;
  try {
    let result;
    if (custom) {
      providerResult = await generateCustomPackagingImage({ option, brief, references: custom.references, key: apiKey, fetcher });
      result = providerResult;
    } else if (mode === 'model') {
      const preset = kit.packPresets[option];
      const optionSlug = option.toLowerCase();
      const references = [
        { role: 'product', asset: workspace.asset('source-146', 'source') },
        { role: 'approved-packaging', asset: workspace.asset(body.baseId || `pack-${optionSlug}-kit`, slot) },
        { role: 'supplier-structure', asset: workspace.asset(`pack-${optionSlug}-structure`) },
        { role: 'graphic', asset: workspace.asset('lemon-original') },
      ];
      if (body.printAssetId) {
        const print = workspace.asset(field(body.printAssetId, '印花选稿', 64));
        if (!['printA', 'printB'].includes(print.slot) || workspace.state().selected[print.slot] !== print.id) {
          fail(422, '模型只能引用当前已选中的印花稿。');
        }
        references.push({ role: 'approved-print', asset: print });
      }
      providerResult = await generatePackagingImage({
        preset, brief, key: apiKey, fetcher,
        references: references.map(({ role, asset }) => ({ role, bytes: workspace.load(asset), mimeType: asset.mimeType })),
      });
      result = providerResult;
    } else {
      if (mode === 'local') {
        workspace.load(workspace.asset(field(body.baseId, '包装参考图', 64), slot));
        if (body.treatment && !['copy', 'lighter', 'darker'].includes(body.treatment)) fail(422, '本地包装操作有误。');
      }
      if (body.failure) fail(422, field(body.failure, '生成失败原因', 250));
      result = upload(body.image);
    }
    const kind = { local: body.treatment === 'copy' ? 'local_copy' : 'local_adjustment', upload: 'uploaded_preview', model: 'model_preview' }[mode];
    const mimeType = imageType(result.bytes);
    const asset = {
      ...newAsset({ slot, kind, label: `Pack ${option} · ${{ local: body.treatment === 'copy' ? '本地复制稿' : '本地改色稿', model: '模型候选稿', upload: '导入候选稿' }[mode]}`,
        notes: brief || productionLabel, mimeType, providerRequestId: result.requestId }),
      ...custom?.provenance,
    };
    workspace.recordResult(job, asset, result.bytes);
    return asset;
  } catch (error) {
    const detail = error instanceof WorkspaceError ? error.message :
      (mode === 'model' ? (error.publicMessage || '百炼生成失败，请核对服务状态后按记录重试。') : '生成未完成，请重试该包装选项。');
    const uncertain = mode === 'model' && (Boolean(providerResult) ||
      (!(error instanceof WorkspaceError) && error.uncertain !== false));
    workspace.finishJob({ ...job, error: detail, providerRequestId: providerResult?.requestId || error.requestId },
      uncertain ? 'needs_review' : 'failed');
    fail(uncertain ? 409 : 422, detail);
  } finally {
    workspace.runningJobs.delete(id);
  }
}

async function sceneImage(workspace, body, apiKey, fetcher) {
  if (!apiKey || body.confirmed !== true) fail(422, '请先配置模型密钥，并确认本次场景图生成。');
  const id = requestId(body.requestId);
  const scene = field(body.scene, '场景', 40);
  if (!Object.hasOwn(scenePresets, scene)) fail(422, '请选择有效场景。');
  const brief = field(body.brief ?? '', '场景要求', 1500, scene === 'custom').trim();
  const { references, provenance } = currentProductReferences(workspace, body, '场景图');
  const slot = 'lifestyle';
  const job = { id, slot, mode: 'model', brief, scene, ...provenance, createdAt: new Date().toISOString() };
  workspace.claimJob(job);
  workspace.runningJobs.add(id);
  let result;
  try {
    result = await generateSceneImage({ scene, brief, references, key: apiKey, fetcher });
    const mimeType = imageType(result.bytes);
    const asset = {
      ...newAsset({ slot, kind: 'model_preview', label: scenePresets[scene].label,
        notes: brief, mimeType, providerRequestId: result.requestId }),
      scene, ...provenance,
    };
    workspace.recordResult(job, asset, result.bytes);
    return asset;
  } catch (error) {
    const detail = error.publicMessage || '场景图生成结果未确认，请核对模型服务记录。';
    const uncertain = Boolean(result) || error.uncertain !== false;
    workspace.finishJob({ ...job, error: detail, providerRequestId: result?.requestId || error.requestId },
      uncertain ? 'needs_review' : 'failed');
    fail(uncertain ? 409 : 422, detail);
  } finally {
    workspace.runningJobs.delete(id);
  }
}

function resolveModelJob(workspace, slot, body) {
  const id = requestId(body.requestId);
  const job = workspace.jobs().find(job => job.id === id && job.slot === slot);
  if (!job || !['running', 'needs_review'].includes(job.status) || workspace.runningJobs.has(id) ||
      body.providerChecked !== true) fail(422, '请先核对供应商任务状态。');
  workspace.finishJob({ ...job, error: '已人工核对，允许单独重新提交。' }, 'failed');
}

function snapshot(workspace, project, state, version) {
  if (!workspace.hasTemplate && (!state.product || !state.selected.source)) {
    fail(422, '请先在「商品资料」填写商品信息并上传商品主图。');
  }
  const product = projectProduct(workspace, state);
  const selections = {};
  for (const [slot, id] of Object.entries(state.selected)) {
    const asset = id === null ? null : workspace.asset(id, slot);
    selections[slot] = modelPreviewIsCurrent(asset, state, product) ? asset : null;
  }
  return {
    id: project.id, version, collection: project.isDemo ? kit.demo.collection : project.name,
    product,
    buyer: state.buyer, selections,
    ...(workspace.hasTemplate ? { packPresets: kit.packPresets } : { projectMode: 'blank' }),
  };
}

function factoryChecklist(workspace, project) {
  if (workspace.hasTemplate) return readKit('06-factory/factory-request.txt');
  const product = workspace.state().product;
  const subject = product ? `${product.nameZh}（货号 ${product.sku}）` : project.name;
  return Buffer.from(['生产规格确认清单', `项目：${project.name}`, `商品：${subject}`, '',
    '请工厂确认商品尺寸、公差、材质和容量。', '请确认可印范围、工艺和印花文件要求。',
    '请确认包装内外尺寸、材质、内托适配及运输测试。', '请提供起订量、打样费用和交期。', '',
  ].join('\n'));
}

export function createPorviaServer({
  workspace: demoWorkspace = new Workspace(),
  apiKey = process.env.PORVIA_BAILIAN_API_KEY,
  sceneFetcher,
  packagingFetcher,
} = {}) {
  const projects = new Projects(demoWorkspace);
  const catalog = new Catalog(demoWorkspace.dataDir);
  const settings = new ModelSettings(demoWorkspace.dataDir, apiKey);
  const server = createServer(async (req, res) => {
    try {
      if (!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host ?? '') &&
          !/^localhost(?::\d+)?$/.test(req.headers.host ?? '')) fail(403, '请通过本机地址打开工作台。');
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;
      const method = req.method;
      const catalogPath = /^\/api\/catalog\/([a-z0-9-]{1,64})(\/image)?$/i.exec(path);
      if (method === 'GET') {
        if (staticFiles.has(path)) {
          const [filename, type] = staticFiles.get(path);
          return send(res, 200, readFileSync(resolve(root, 'public', filename)), { 'Content-Type': type });
        }
        if (path === '/favicon.ico') {
          res.writeHead(204);
          return res.end();
        }
        if (path === '/api/projects') return send(res, 200, { projects: projects.list() });
        if (path === '/api/catalog') return send(res, 200, { products: catalog.list() });
        if (path === '/api/settings/model') return send(res, 200, settings.status());
        if (catalogPath?.[2]) {
          const { bytes, mimeType } = catalog.read(catalogPath[1]);
          return send(res, 200, bytes, { 'Content-Type': mimeType });
        }
      }
      if (method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) fail(403, '只允许本机工作台提交。');
        if (path === '/api/settings/model') {
          const body = await readJson(req);
          return send(res, 200, settings.save(body.apiKey));
        }
        if (path === '/api/projects') {
          const body = await readJson(req);
          const name = field(body.name, '项目名称', 80).trim();
          const customer = field(body.customer ?? '', '客户名称', 80, false).trim();
          const template = body.template ?? 'blank';
          if (!['blank', 'lemon'].includes(template)) fail(422, '请选择有效的项目模板。');
          const project = projects.create({ name, customer, template, requestId: requestId(body.requestId) });
          return send(res, 201, { project });
        }
        if (path === '/api/catalog') {
          const body = await readJson(req);
          const product = catalog.create(productDetails(body), upload(body.image));
          return send(res, 201, { product });
        }
        if (catalogPath && !catalogPath[2]) {
          const body = await readJson(req);
          if (!Number.isSafeInteger(body.revision) || body.revision < 1) fail(422, '商品资料版本无效。');
          const image = body.image === undefined ? undefined : upload(body.image);
          const product = catalog.update(catalogPath[1], body.revision, productDetails(body), image);
          return send(res, 200, { product });
        }
      }
      if (url.searchParams.getAll('project').length > 1) fail(422, '每次只能指定一个项目。');
      const { project, workspace } = projects.open(url.searchParams.get('project'));
      if (method === 'GET') {
        if (path === '/api/workspace') return send(res, 200, view(workspace, project, settings.status().configured));
        if (path === '/api/factory-request') {
          return send(res, 200, factoryChecklist(workspace, project), {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'attachment; filename="porvia-factory-request.txt"',
          });
        }
        const image = /^\/api\/assets\/([^/]+)$/.exec(path);
        if (image) {
          if (!identifier.test(image[1])) fail(422, '素材引用无效。');
          const asset = workspace.asset(image[1]);
          return send(res, 200, workspace.load(asset), {
            'Content-Type': asset.mimeType, 'Content-Disposition': `inline; filename="${asset.filename}"`,
          });
        }
        const pdf = /^\/api\/versions\/(\d+)\/pdf$/.exec(path);
        if (pdf) {
          const version = Number(pdf[1]);
          const filename = project.isDemo ? `Porvia-Lemon-and-Blue-Flowers-V${version}.pdf` : `Porvia-${project.id.slice(0, 8)}-V${version}.pdf`;
          return send(res, 200, workspace.download(version), {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `${url.searchParams.has('inline') ? 'inline' : 'attachment'}; filename="${filename}"`,
          });
        }
      }
      if (method !== 'POST') fail(404, '找不到此页面。');
      const body = await readJson(req);
      if (path === '/api/inquiry/upload') return send(res, 200, { text: await readInquiryUpload(body) });
      const refresh = result => send(res, 200, { result, workspace: view(workspace, project, settings.status().configured) });
      const revision = body.revision;
      if (path === '/api/product') {
        if (workspace.hasTemplate) fail(422, '请在空白项目中录入自己的商品。');
        const product = { ...productDetails(body), factoryConfirmed: false };
        workspace.update(revision, state => {
          state.product = product;
          clearOutdatedSelectedPreviews(workspace, state);
        });
        return refresh(product);
      }
      if (path === '/api/product/from-library') {
        if (workspace.hasTemplate) fail(422, '请在空白项目中从资料库选择商品。');
        if (typeof body.libraryId !== 'string' || !identifier.test(body.libraryId)) fail(422, '商品引用无效。');
        if (!Number.isSafeInteger(body.libraryRevision) || body.libraryRevision < 1) fail(422, '商品资料版本无效。');
        const { bytes, mimeType, product } = catalog.read(body.libraryId);
        if (product.revision !== body.libraryRevision) fail(409, '商品资料已更新，请重新选择。');
        const { sku, nameZh, nameEn } = product;
        const copied = { sku, nameZh, nameEn, factoryConfirmed: false };
        workspace.update(revision, state => {
          const photo = newAsset({ slot: 'source', kind: 'uploaded_product_photo', label: `${sku} 商品主图`, mimeType });
          workspace.addAsset(photo, bytes);
          state.product = copied;
          state.selected.source = photo.id;
          clearOutdatedSelectedPreviews(workspace, state);
        });
        return refresh(copied);
      }
      const productImage = /^\/api\/product\/images\/(source|artwork|lifestyle)$/.exec(path);
      if (productImage) {
        const slot = productImage[1];
        if (workspace.hasTemplate && slot !== 'lifestyle') fail(422, '请在空白项目中上传自己的商品图片。');
        const label = field(body.filename ?? '', '文件名', 240, false).trim() ||
          { source: '商品主图', artwork: '印花素材', lifestyle: '场景图片' }[slot];
        const { bytes, mimeType } = upload(body.image);
        if (slot === 'artwork' && mimeType !== 'image/png') fail(422, '印花素材请上传 PNG 图片。');
        const kind = { source: 'uploaded_product_photo', artwork: 'uploaded_artwork', lifestyle: 'uploaded_preview' }[slot];
        const asset = workspace.update(revision, state => {
          const saved = newAsset({ slot, kind, label, mimeType });
          workspace.addAsset(saved, bytes);
          if (slot === 'artwork') state.artworkId = saved.id;
          else state.selected[slot] = saved.id;
          if (slot === 'source') clearOutdatedSelectedPreviews(workspace, state);
          return saved;
        });
        return refresh(asset);
      }
      if (path === '/api/scenes') return refresh(await sceneImage(workspace, body, settings.effectiveKey(), sceneFetcher));
      if (path === '/api/scenes/resolve') {
        resolveModelJob(workspace, 'lifestyle', body);
        return refresh(null);
      }
      if (path === '/api/inquiry') {
        const text = field(body.text, '询盘', 16000, false);
        const result = text.trim() ? extractInquiry(text) : null;
        workspace.update(revision, state => {
          const review = state.inquiry?.text === text ? state.inquiry.review : undefined;
          state.inquiry = result ? { text, result, ...(review ? { review } : {}) } : null;
        });
        return refresh(result);
      }
      if (path === '/api/inquiry/review') {
        const review = workspace.update(revision, state => {
          const updates = reviewInquiry(state.inquiry, body.fields);
          state.inquiry.review = updates;
          return updates;
        });
        return refresh(review);
      }
      if (path === '/api/buyer' || path === '/api/inquiry/continue') {
        const result = workspace.update(revision, state => {
          const inquiry = effectiveInquiry(state.inquiry);
          if (!inquiry) fail(422, '请先提取询盘字段。');
          const use = typeof inquiry.use === 'string' && inquiry.use.trim() ? inquiry.use : null;
          const quantity = acceptedInquiryQuantity(state.inquiry, inquiry);
          const quantityQualifier = quantity === null ? '' : inquiry.quantityQualifier || '';

          if (path === '/api/inquiry/continue') {
            state.buyer = {
              use, quantity, quantityQualifier,
              quantityUnit: state.buyer.quantityUnit || kit.demo.quantityUnit,
              packaging: Array.isArray(inquiry.packaging) ? inquiry.packaging : [],
              print: inquiry.print || null,
              ...(inquiry.sku ? { sku: inquiry.sku } : {}),
              ...(inquiry.packagingConfirmed || Object.hasOwn(state.inquiry.review ?? {}, 'packagingConfirmed')
                ? { packagingConfirmed: inquiry.packagingConfirmed } : {}),
            };
            clearOutdatedSelectedPreviews(workspace, state);
          } else {
            if (use === null && quantity === null) fail(422, '没有可用于提案的用途或数量。');
            if (use !== null) state.buyer.use = use;
            if (quantity !== null) {
              state.buyer.quantity = quantity;
              state.buyer.quantityQualifier = quantityQualifier;
            }
          }
          return state.buyer;
        });
        return refresh(result);
      }
      if (path === '/api/replies') {
        const input = field(body.text, '采购回复', 8000);
        const result = scoreBuyerReply(input);
        workspace.update(revision, state => {
          state.replies.unshift({ id: randomUUID(), createdAt: new Date().toISOString(), input, ...result });
        });
        return refresh(result);
      }
      const print = /^\/api\/prints\/([AB])$/.exec(path);
      if (print) {
        const option = print[1];
        const config = workspace.hasTemplate ? kit.print : blankPrint;
        const position = validPosition(body.position, config.editableArea);
        const asset = workspace.update(revision, state => {
          const source = workspace.hasTemplate ? 'source-146' : state.selected.source;
          const artwork = workspace.hasTemplate ? 'lemon-original' : state.artworkId;
          if (!source || !artwork) fail(422, '请先在「商品资料」上传商品主图和印花素材。');
          workspace.load(workspace.asset(source, 'source'));
          workspace.load(workspace.asset(artwork, workspace.hasTemplate ? null : 'artwork'));
          state.prints[option] = { ...state.prints[option], ...position };
          const { bytes, mimeType } = upload(body.image);
          if (mimeType !== 'image/png') fail(422, '贴图候选稿应为 PNG。');
          const saved = newAsset({ slot: `print${option}`, kind: 'local_overlay', label: `Print ${option} · 贴图稿`,
            notes: productionLabel, mimeType, position });
          workspace.addAsset(saved, bytes);
          return saved;
        });
        return refresh(asset);
      }
      if (path === '/api/select') {
        const slot = field(body.slot, '选项', 12);
        if (!['printA', 'printB', 'packA', 'packB', 'source', 'lifestyle'].includes(slot)) fail(422, '选项不存在。');
        const remove = body.assetId === null;
        const asset = remove ? null : workspace.asset(field(body.assetId, '选稿编号', 64), slot);
        if (asset) workspace.load(asset);
        workspace.update(revision, state => {
          if (!modelPreviewIsCurrent(asset, state, projectProduct(workspace, state))) {
            const subject = slot === 'lifestyle' ? '场景图' : '包装图';
            fail(422, `此${subject}与当前货号、主图或印花选稿不一致，请选择对应的${subject}。`);
          }
          if (asset && slot.startsWith('pack') && !['ai_preview', 'demo_illustration'].includes(asset.kind) &&
              state.packing[slot.at(-1)].reviewed[asset.id] !== 'approved') fail(422, '请先完成该候选稿的预览审核。');
          state.selected[slot] = asset?.id ?? null;
          if (slot === 'source' || slot === 'printA' || slot === 'printB') clearOutdatedSelectedPreviews(workspace, state);
        });
        return refresh(asset);
      }
      const packing = /^\/api\/packaging\/([AB])(?:\/(review|resolve))?$/.exec(path);
      if (packing) {
        const option = packing[1];
        const slot = `pack${option}`;
        if (packing[2] === 'review') {
          const asset = workspace.asset(field(body.assetId, '候选稿编号', 64), slot);
          const status = body.status;
          if (status !== 'approved' && status !== 'rejected') fail(422, '审核结果有误。');
          if (status === 'approved' && body.checked !== true) fail(422, '请逐项检查视觉审核要求。');
          workspace.update(revision, state => {
            if (!modelPreviewIsCurrent(asset, state, projectProduct(workspace, state))) {
              fail(422, '此包装图与当前货号、主图或印花选稿不一致，请重新生成。');
            }
            if (state.selected[slot] === asset.id && status === 'rejected') fail(422, '请先取消该图片的提案选稿。');
            state.packing[option].reviewed[asset.id] = status;
          });
          return refresh(asset);
        }
        if (packing[2] === 'resolve') {
          resolveModelJob(workspace, slot, body);
          return refresh(null);
        }
        const key = body.mode === 'model' ? settings.effectiveKey() : null;
        return refresh(await packageImage(workspace, option, body, key, packagingFetcher));
      }
      if (path === '/api/versions') {
        const id = requestId(body.requestId);
        const existing = workspace.versionForRequest(id);
        if (existing) return refresh({ version: existing });
        const state = workspace.state();
        if (revision !== state.revision) fail(409, '工作台已更新，请重新检查选稿。');
        const version = workspace.latestVersion() + 1;
        const frozen = snapshot(workspace, project, state, version);
        let pdf;
        try {
          pdf = await createProposalPdf(frozen, asset => workspace.load(asset));
        } catch (error) {
          fail(422, '无法导出 PDF。' + (error.cause?.message || error.message));
        }
        workspace.update(revision, () => workspace.saveVersion(frozen, id, pdf));
        return refresh({ version });
      }
      fail(404, '找不到此接口。');
    } catch (error) {
      if (!(error instanceof WorkspaceError)) console.error(error);
      send(res, error.status || 500, { error: error.status ? error.message : '本地服务暂时无法完成操作。' });
    }
  });
  server.once('close', () => {
    projects.close();
    catalog.close();
  });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT || 4186);
  createPorviaServer().listen(port, '127.0.0.1', () => console.log(`Porvia 工作台 http://127.0.0.1:${port}`));
}

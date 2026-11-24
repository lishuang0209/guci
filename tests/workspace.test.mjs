import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { kit, readKit } from '../src/kit.mjs';
import { createPorviaServer } from '../src/server.mjs';
import { Workspace } from '../src/store.mjs';

async function startWorkspace(t, { apiKey = '', sceneFetcher, packagingFetcher, dataDir: sharedDataDir } = {}) {
  const dataDir = sharedDataDir ?? await mkdtemp(join(tmpdir(), 'porvia-workspace-test-'));
  const workspace = new Workspace(dataDir);
  const server = createPorviaServer({ workspace, apiKey, sceneFetcher, packagingFetcher });
  let closed = false;
  async function close() {
    if (closed) return;
    await new Promise((resolve, reject) => server.close(error =>
      error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    workspace.db.close();
    closed = true;
  }
  t.after(async () => {
    await close();
    if (!sharedDataDir) await rm(dataDir, { force: true, recursive: true });
  });

  let baseUrl;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
    t.diagnostic('TCP listening is sandboxed. Invoking the production HTTP handler with in-memory streams.');
  }

  async function request(path, body) {
    const method = body === undefined ? 'GET' : 'POST';
    const headers = { host: '127.0.0.1' };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers.Origin = baseUrl ?? 'http://127.0.0.1';
    }
    if (baseUrl) {
      delete headers.host;
      const response = await fetch(baseUrl + path, { method, headers, body: payload });
      return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
    }

    const incoming = Readable.from(payload ? [Buffer.from(payload)] : []);
    incoming.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    incoming.method = method;
    incoming.url = path;
    const response = {};
    const outgoing = {
      writeHead(status, headers) {
        response.status = status;
        response.headers = new Headers(headers);
      },
      end(bytes) {
        response.bytes = bytes ?? Buffer.alloc(0);
      },
    };
    await server.listeners('request')[0](incoming, outgoing);
    return response;
  }

  async function json(path, body, expectedStatus = 200) {
    const response = await request(path, body);
    const data = JSON.parse(response.bytes);
    assert.equal(response.status, expectedStatus, `${path}: ${data.error ?? response.status}`);
    return data;
  }
  return { json, request, close };
}

function getAssetImage(id) {
  const item = kit.assets.find(asset => asset.id === id);
  assert.ok(item, `Fixture asset ${id} is available`);
  return readKit(item.path);
}

function assertErrorMessage(response, phrase) {
  assert.match(response.error, phrase);
}

test('seeds SKU 146, preserves source evidence, and rejects stale or cross-slot writes', async t => {
  const { json, request } = await startWorkspace(t);
  const initial = await json('/api/workspace');
  assert.equal(initial.revision, 0);
  assert.equal(initial.kit.product.sku, '146');
  assert.equal(initial.kit.product.capacity.value, 210);
  assert.match(initial.kit.product.sourceUrl, /^https:\/\/luxurybonechina\.com\//);
  assert.equal(initial.kit.product.factoryConfirmed, false);
  assert.equal(initial.kit.factory.measurementsMm.cupWidthWithHandle, null);
  assert.equal(initial.kit.factory.packaging.fitTestPassed, false);
  assert.equal(initial.modelAvailable, false);
  assert.equal(initial.sceneModelAvailable, false);
  assert.deepEqual(await json('/api/settings/model'), {
    configured: false, savedLocally: false, model: 'qwen-image-2.1-turbo',
  });
  assert.equal(initial.assets.find(item => item.id === 'source-146')?.kind, 'demo_illustration');
  assert.equal(initial.assets.find(item => item.id === 'print-a-kit')?.kind, 'demo_illustration');
  assert.equal(initial.kit.print.productId, initial.kit.product.id);

  const source = await request('/api/assets/source-146');
  assert.equal(source.status, 200);
  assert.equal(source.headers.get('content-type'), 'image/jpeg');
  assert.ok(source.bytes.equals(getAssetImage('source-146')));

  const inquiry = 'Model 146 for hotel breakfast. Around 550 sets initially. Please offer a folding carton.';
  const imported = await json('/api/inquiry/upload', { filename: 'buyer-inquiry.txt', content: Buffer.from(inquiry).toString('base64') });
  assert.equal(imported.text, inquiry);
  assert.equal((await json('/api/workspace')).revision, initial.revision);
  const extracted = await json('/api/inquiry', { revision: initial.revision, text: inquiry });
  assert.equal(extracted.result.sku, '146');
  assert.equal(extracted.result.quantity, 550);
  assert.equal(extracted.result.evidence.sku, 'Model 146');
  assert.equal(extracted.result.evidence.quantity, 'Around 550 sets initially');
  assert.equal(extracted.result.factoryConfirmed, false);
  assert.equal(extracted.workspace.inquiry.text, inquiry);
  assert.equal(extracted.workspace.revision, initial.revision + 1);

  assertErrorMessage(await json('/api/buyer', { revision: initial.revision }, 409), /更新/);
  const adopted = await json('/api/buyer', { revision: extracted.workspace.revision });
  assert.equal(adopted.workspace.buyer.quantity, 550);
  assert.equal(adopted.workspace.buyer.use, 'hotel breakfast');

  assertErrorMessage(await json('/api/select', {
    revision: adopted.workspace.revision, slot: 'packB', assetId: 'pack-a-kit',
  }, 422), /超出当前选项范围/);

  const print = initial.kit.print.options[0];
  assertErrorMessage(await json('/api/prints/A', {
    revision: adopted.workspace.revision, position: { ...print, centerX: 1.1 },
  }, 422), /超出可编辑范围/);
  const current = await json('/api/workspace');
  assert.equal(current.revision, adopted.workspace.revision);
  assert.deepEqual(current.selected, initial.selected);

  const cleared = await json('/api/inquiry', { revision: current.revision, text: ' \n ' });
  assert.equal(cleared.result, null);
  assert.equal((await json('/api/workspace')).inquiry, null);
  assert.equal(cleared.workspace.buyer.quantity, 550);
  assertErrorMessage(await json('/api/buyer', { revision: cleared.workspace.revision }, 422), /先提取询盘/);
});

test('carries a gift-box inquiry into the proposal without reusing the sample quantity', async t => {
  const { json, request } = await startWorkspace(t);
  const initial = await json('/api/workspace');
  assertErrorMessage(await json('/api/inquiry/continue', { revision: initial.revision }, 422), /先提取询盘/);
  const original = await json('/api/versions', { revision: initial.revision, requestId: randomUUID() });
  const originalPdf = await request('/api/versions/1/pdf');
  const text = kit.cases.find(item => item.id === 'missing').input;
  const extracted = await json('/api/inquiry', { revision: original.workspace.revision, text });
  assertErrorMessage(await json('/api/inquiry/continue', { revision: original.workspace.revision }, 409), /更新/);
  assertErrorMessage(await json('/api/buyer', { revision: extracted.workspace.revision }, 422), /没有可用于提案/);

  const continued = await json('/api/inquiry/continue', { revision: extracted.workspace.revision });
  assert.deepEqual(continued.result, {
    use: null, quantity: null, quantityQualifier: '', quantityUnit: 'sets', packaging: ['gift box'], print: null,
  });
  const current = await json('/api/workspace');
  assert.deepEqual(current.buyer, continued.result);
  assert.deepEqual(current.selected, initial.selected);
  assert.deepEqual(current.versions, original.workspace.versions);
  const originalAgain = await request('/api/versions/1/pdf');
  assert.ok(originalAgain.bytes.equals(originalPdf.bytes));

  const next = await json('/api/versions', { revision: current.revision, requestId: randomUUID() });
  assert.deepEqual(next.workspace.versions[0].snapshot.buyer, continued.result);
  const nextPdf = await request('/api/versions/2/pdf');
  assert.doesNotMatch(nextPdf.bytes.toString('latin1'), /Planned order \/ Approximately 500 sets/);
});

test('keeps human inquiry edits separate from evidence and uses reviewed fields in the proposal', async t => {
  const { json } = await startWorkspace(t);
  const initial = await json('/api/workspace');
  assertErrorMessage(await json('/api/inquiry/review', {
    revision: initial.revision, fields: { quantity: 510 },
  }, 422), /先提取/);

  const text = 'Model 146 for hotel breakfast. The email says 300 sets, but the note says 500 sets. Please show a folding carton or rigid gift box.';
  const extracted = await json('/api/inquiry', { revision: initial.revision, text });
  const revision = extracted.workspace.revision;
  assert.equal(extracted.result.quantity, null);
  assert.deepEqual(extracted.result.quantityCandidates, [300, 500]);
  assert.deepEqual(extracted.result.packaging, ['folding carton', 'rigid gift box']);
  for (const [fields, pattern] of [
    [{ quantity: 1.5 }, /整数/],
    [{ packagingConfirmed: true }, /实际确认的一种包装/],
    [{ factoryConfirmed: true }, /不可.*修改/],
  ]) {
    assertErrorMessage(await json('/api/inquiry/review', { revision, fields }, 422), pattern);
  }
  assertErrorMessage(await json('/api/inquiry/review', {
    revision: initial.revision, fields: { quantity: 510 },
  }, 409), /更新/);

  const fields = {
    use: '酒店团购', quantity: 510, quantityQualifier: '首批', sku: '146-B', print: '无印花',
    packaging: ['rigid gift box'], packagingConfirmed: true,
  };
  const reviewed = await json('/api/inquiry/review', { revision, fields });
  assert.deepEqual(reviewed.result, fields);
  assert.deepEqual(reviewed.workspace.inquiry.result, extracted.result);
  assert.equal(reviewed.workspace.inquiry.text, text);
  assert.deepEqual((await json('/api/workspace')).inquiry.review, fields);

  const repeated = await json('/api/inquiry', { revision: reviewed.workspace.revision, text });
  assert.deepEqual(repeated.workspace.inquiry.review, fields);
  const adopted = await json('/api/buyer', { revision: repeated.workspace.revision });
  assert.equal(adopted.result.quantity, 510);
  assert.equal(adopted.result.use, '酒店团购');
  const continued = await json('/api/inquiry/continue', { revision: adopted.workspace.revision });
  assert.deepEqual(continued.result, { ...fields, quantityUnit: 'sets' });
  assert.equal(continued.workspace.kit.product.sku, '146');

  const updated = await json('/api/inquiry/review', {
    revision: continued.workspace.revision, fields: { quantity: null, packaging: ['folding carton'] },
  });
  assert.equal(updated.result.quantityQualifier, null);
  assert.equal(updated.result.packagingConfirmed, false);
  const provisional = await json('/api/inquiry/continue', { revision: updated.workspace.revision });
  assert.equal(provisional.result.quantity, null);
  assert.equal(provisional.result.packagingConfirmed, false);

  const fresh = await json('/api/inquiry', { revision: provisional.workspace.revision, text: 'We need 620 sets.' });
  assert.equal(fresh.workspace.inquiry.review, undefined);
  assert.equal(fresh.result.quantity, 620);
});

test('keeps packaging jobs independent, reviews before selecting, and freezes both PDF versions', async t => {
  const { json, request } = await startWorkspace(t);
  const initial = await json('/api/workspace');
  const v1Request = randomUUID();
  const packBRetry = randomUUID();

  const failure = await json('/api/packaging/B', {
    requestId: randomUUID(), mode: 'local', baseId: 'pack-a-kit', revision: initial.revision,
  }, 422);
  assertErrorMessage(failure, /超出当前选项范围/);

  const [a, b] = await Promise.all([
    json('/api/packaging/A', {
      requestId: randomUUID(), mode: 'local', baseId: 'pack-a-kit', revision: initial.revision,
      image: getAssetImage('pack-a-kit').toString('base64'), brief: 'Keep the carton sample for review.',
    }),
    json('/api/packaging/B', {
      requestId: packBRetry, mode: 'local', baseId: 'pack-b-kit', revision: initial.revision,
      image: getAssetImage('pack-b-kit').toString('base64'), brief: 'Make Pack B lighter green and retain the gold-foil sprig.',
    }),
  ]);
  assert.equal(a.result.slot, 'packA');
  assert.equal(b.result.slot, 'packB');
  assert.notEqual(a.result.id, b.result.id);
  assert.equal(b.result.kind, 'local_adjustment');

  const history = await json('/api/workspace');
  assert.deepEqual(history.selected, initial.selected);
  assert.equal(history.jobs.filter(job => job.slot === 'packA' && job.status === 'succeeded').length, 1);
  assert.equal(history.jobs.filter(job => job.slot === 'packB' && job.status === 'failed').length, 1);
  assert.equal(history.jobs.find(job => job.id === packBRetry)?.assetId, b.result.id);
  const viewedCandidate = await request(`/api/assets/${b.result.id}`);
  assert.equal(viewedCandidate.status, 200);
  assert.ok(viewedCandidate.bytes.equals(getAssetImage('pack-b-kit')));

  assertErrorMessage(await json('/api/select', {
    revision: history.revision, slot: 'packB', assetId: b.result.id,
  }, 422), /先完成.*审核/);
  assertErrorMessage(await json('/api/packaging/B/review', {
    revision: history.revision, assetId: b.result.id, status: 'approved', checked: false,
  }, 422), /逐项检查/);

  const v1 = await json('/api/versions', { revision: history.revision, requestId: v1Request });
  assert.equal(v1.result.version, 1);
  const v1Snapshot = v1.workspace.versions[0].snapshot;
  assert.equal(v1Snapshot.selections.packA.id, 'pack-a-kit');
  assert.equal(v1Snapshot.selections.packB.id, 'pack-b-kit');
  const firstDownload = await request('/api/versions/1/pdf');
  assert.equal(firstDownload.status, 200);
  assert.equal(firstDownload.headers.get('content-type'), 'application/pdf');
  assert.match(firstDownload.headers.get('content-disposition'), /^attachment;.*V1\.pdf/);
  assert.match(firstDownload.bytes.toString('latin1'), /\/Type \/Pages \/Count 4\b/);

  const reviewed = await json('/api/packaging/B/review', {
    revision: v1.workspace.revision, assetId: b.result.id, status: 'approved', checked: true,
  });
  assert.equal(reviewed.workspace.packing.B.reviewed[b.result.id], 'approved');
  assert.deepEqual(reviewed.workspace.selected, initial.selected);

  const selected = await json('/api/select', {
    revision: reviewed.workspace.revision, slot: 'packB', assetId: b.result.id,
  });
  assert.equal(selected.workspace.selected.packB, b.result.id);
  assert.equal(selected.workspace.selected.packA, initial.selected.packA);
  const v2 = await json('/api/versions', { revision: selected.workspace.revision, requestId: randomUUID() });
  assert.equal(v2.result.version, 2);
  const [v2Snapshot, savedV1] = v2.workspace.versions.map(item => item.snapshot);
  assert.deepEqual(savedV1, v1Snapshot);
  assert.equal(v2Snapshot.selections.packB.id, b.result.id);
  assert.equal(v2Snapshot.selections.packB.notes, b.result.notes);
  assert.equal(v2Snapshot.selections.packA.id, v1Snapshot.selections.packA.id);
  assert.equal(v2Snapshot.selections.printA.id, v1Snapshot.selections.printA.id);
  assert.ok(!Object.values(v2Snapshot.selections).some(asset => asset?.id === a.result.id));

  const v2Download = await request('/api/versions/2/pdf?inline');
  assert.equal(v2Download.status, 200);
  assert.match(v2Download.headers.get('content-disposition'), /^inline;.*V2\.pdf/);
  const v2Contents = v2Download.bytes.toString('latin1');
  assert.match(v2Contents, /\(BUYER PROPOSAL \/ DEMO-001 \/ V2\) Tj/);
  assert.equal([...v2Contents.matchAll(/\/Subtype \/Image /g)].length, 6);
  assert.ok(!v2Download.bytes.equals(firstDownload.bytes));
  const v1Again = await request('/api/versions/1/pdf');
  assert.ok(v1Again.bytes.equals(firstDownload.bytes));

  const repeated = await json('/api/versions', { revision: history.revision, requestId: v1Request });
  assert.equal(repeated.result.version, 1);
  assert.equal(repeated.workspace.revision, v2.workspace.revision);
  assert.deepEqual(repeated.workspace.versions.map(item => item.version), [2, 1]);
});

test('creates separate projects and keeps the example as an independently openable workspace', async t => {
  const { json } = await startWorkspace(t);
  const initial = await json('/api/projects');
  assert.equal(initial.projects.length, 1);
  const [demo] = initial.projects;
  assert.equal(demo.id, kit.demo.id);
  assert.equal(demo.isDemo, true);
  assertErrorMessage(await json('/api/projects', { name: ' ', requestId: randomUUID() }, 422), /项目名称/);

  const fields = { name: '  North Hotel  ', customer: '  North Group  ', requestId: randomUUID() };
  const { project } = await json('/api/projects', fields, 201);
  assert.equal(project.name, 'North Hotel');
  assert.equal(project.customer, 'North Group');
  assert.equal(project.template, 'blank');
  assert.equal(project.isDemo, false);
  const retried = await json('/api/projects', fields, 201);
  assert.deepEqual(retried.project, project);
  assertErrorMessage(await json('/api/projects', { ...fields, name: 'Different project' }, 409), /请求已保存/);
  const { project: fromLemon } = await json('/api/projects', {
    name: 'Template copy', template: 'lemon', requestId: randomUUID(),
  }, 201);
  assert.deepEqual((await json('/api/projects')).projects, [fromLemon, project, demo]);

  const blank = await json(`/api/workspace?project=${project.id}`);
  assert.equal(blank.revision, 0);
  assert.equal(blank.inquiry, null);
  assert.equal(blank.kit.product, null);
  assert.equal(blank.kit.demo, null);
  assert.equal(blank.buyer.quantity, null);
  assert.equal(blank.buyer.use, null);
  assert.ok(Object.values(blank.selected).every(selection => selection === null));
  assert.deepEqual(blank.assets, []);
  assert.deepEqual(blank.versions, []);
  const template = await json(`/api/workspace?project=${fromLemon.id}`);
  assert.equal(template.kit.product.sku, '146');
  assert.equal(template.selected.packA, 'pack-a-kit');
  assert.equal(template.buyer.quantity, null);
  assert.equal(template.inquiry, null);
  assert.deepEqual(template.versions, []);

  const sample = await json(`/api/workspace?project=${demo.id}`);
  assert.deepEqual(await json('/api/workspace'), sample);
  assert.equal(sample.buyer.quantity, 500);
  assertErrorMessage(await json(`/api/workspace?project=${randomUUID()}`, undefined, 404), /找不到此项目/);
});

test('stores blank project inquiries, images, and PDFs under that project only', async t => {
  const { json, request } = await startWorkspace(t);
  const { project } = await json('/api/projects', { name: 'North Hotel', requestId: randomUUID() }, 201);
  const scoped = path => `${path}${path.includes('?') ? '&' : '?'}project=${project.id}`;
  const inquiry = await json(scoped('/api/inquiry'), {
    revision: 0, text: 'Please quote 720 sets for hotel breakfast.',
  });
  const continued = await json(scoped('/api/inquiry/continue'), {
    revision: inquiry.workspace.revision,
  });
  assert.equal(continued.workspace.buyer.quantity, 720);
  assertErrorMessage(await json(scoped('/api/versions'), {
    revision: continued.workspace.revision, requestId: randomUUID(),
  }, 422), /商品资料/);
  const product = await json(scoped('/api/product'), {
    revision: continued.workspace.revision, sku: 'N-29', nameZh: '骨瓷咖啡杯', nameEn: 'Bone China Coffee Cup',
  });
  assert.equal(product.workspace.kit.product.sku, 'N-29');
  assert.deepEqual(product.workspace.kit.print.editableArea, { x: 0, y: 0, width: 1, height: 1 });
  const source = getAssetImage('source-146');
  const photo = await json(scoped('/api/product/images/source'), {
    revision: product.workspace.revision, filename: 'my-cup.jpg', image: source.toString('base64'),
  });
  assert.equal(photo.workspace.selected.source, photo.result.id);
  const png = getAssetImage('lemon-original').toString('base64');
  const design = await json(scoped('/api/product/images/artwork'), {
    revision: photo.workspace.revision, filename: 'my-design.png', image: png,
  });
  assert.equal(design.workspace.artworkId, design.result.id);
  assertErrorMessage(await json(scoped('/api/prints/A'), {
    revision: design.workspace.revision,
    position: { centerX: 1.01, centerY: 0, widthRatio: 0.24, rotationDegrees: 0 },
  }, 422), /超出可编辑范围/);
  const print = await json(scoped('/api/prints/A'), {
    revision: design.workspace.revision,
    position: { centerX: 1, centerY: 0, widthRatio: 0.24, rotationDegrees: 0 },
    image: png,
  });
  const selection = await json(scoped('/api/select'), {
    revision: print.workspace.revision, slot: 'printA', assetId: print.result.id,
  });
  const version = await json(scoped('/api/versions'), {
    revision: selection.workspace.revision, requestId: randomUUID(),
  });
  assert.equal(version.result.version, 1);
  assert.equal(version.workspace.versions[0].snapshot.collection, 'North Hotel');
  assert.equal(version.workspace.versions[0].snapshot.selections.source.id, photo.result.id);
  const pdf = await request(scoped('/api/versions/1/pdf?inline'));
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-disposition'), /^inline;.*V1\.pdf/);
  assert.match(pdf.bytes.toString('latin1'), /\(Planned order \/ 720 sets\) Tj/);
  const download = await request(scoped(`/api/assets/${photo.result.id}`));
  assert.ok(download.bytes.equals(source));
  assertErrorMessage(await json(`/api/assets/${photo.result.id}`, undefined, 422), /素材不存在/);
  assertErrorMessage(await json(scoped('/api/assets/source-146'), undefined, 422), /素材不存在/);
  assertErrorMessage(await json('/api/versions/1/pdf', undefined, 404), /找不到该版本/);
  const demo = await json('/api/workspace');
  assert.equal(demo.revision, 0);
  assert.equal(demo.buyer.quantity, 500);
  assert.equal(demo.inquiry, null);
});

test('catalog stores product metadata and images with unique SKUs and revision checks', async t => {
  const { json, request } = await startWorkspace(t);
  const { products } = await json('/api/catalog');
  const seeded = products.find(item => item.sku === '146');
  assert.equal(seeded.id, 'longway-146');
  assert.equal(seeded.nameZh, kit.product.nameZh);
  assert.ok((await request(`/api/catalog/${seeded.id}/image`)).bytes.equals(getAssetImage('source-146')));
  assertErrorMessage(await json('/api/catalog/missing/image', undefined, 404), /找不到此商品/);

  const source = getAssetImage('source-146');
  const fields = { sku: '  NB-Cup  ', nameZh: '白色骨瓷杯', nameEn: 'White china cup' };
  assertErrorMessage(await json('/api/catalog', fields, 422), /图片/);
  const { product } = await json('/api/catalog', { ...fields, image: source.toString('base64') }, 201);
  assert.equal(product.sku, 'NB-Cup');
  assert.equal(product.revision, 1);
  assertErrorMessage(await json('/api/catalog', {
    ...fields, sku: 'nb-cup', image: source.toString('base64'),
  }, 409), /已存在此货号/);
  assertErrorMessage(await json(`/api/catalog/${product.id}`, {
    ...fields, sku: seeded.sku, revision: product.revision,
  }, 409), /已存在此货号/);

  const edit = { ...fields, nameZh: '白色骨瓷早餐杯', revision: product.revision };
  const { product: revised } = await json(`/api/catalog/${product.id}`, edit);
  assert.equal(revised.revision, 2);
  assert.equal(revised.nameZh, edit.nameZh);
  assertErrorMessage(await json(`/api/catalog/${product.id}`, edit, 409), /已更新/);
  const image = await request(`/api/catalog/${product.id}/image`);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.ok(image.bytes.equals(source));
  assert.deepEqual((await json('/api/catalog')).products.find(item => item.id === revised.id), revised);
});

test('catalog selection copies assets and metadata to each project while keeping proposal history', async t => {
  const { json, request } = await startWorkspace(t);
  const { product } = await json('/api/catalog', {
    sku: 'NB-09', nameZh: '骨瓷茶杯', nameEn: 'Tea cup', image: getAssetImage('source-146').toString('base64'),
  }, 201);
  const { project: first } = await json('/api/projects', { name: 'First order', requestId: randomUUID() }, 201);
  const { project: second } = await json('/api/projects', { name: 'Second order', requestId: randomUUID() }, 201);
  const path = (route, project = first) => `${route}?project=${project.id}`;
  const selection = { revision: 0, libraryId: product.id, libraryRevision: product.revision };
  assertErrorMessage(await json('/api/product/from-library', selection, 422), /空白项目/);
  const adopted = await json(path('/api/product/from-library'), selection);
  assert.equal(adopted.workspace.kit.product.sku, product.sku);
  assert.equal(adopted.workspace.kit.product.nameEn, product.nameEn);
  assert.equal(adopted.workspace.kit.product.factoryConfirmed, false);
  const originalSource = path(`/api/assets/${adopted.workspace.selected.source}`);
  assert.ok((await request(originalSource)).bytes.equals(getAssetImage('source-146')));
  assert.equal((await json(path('/api/workspace', second))).kit.product, null);

  const version = await json(path('/api/versions'), { revision: adopted.workspace.revision, requestId: randomUUID() });
  const firstPdf = await request(path('/api/versions/1/pdf'));
  assert.equal(firstPdf.status, 200);
  const replacement = getAssetImage('lemon-original');
  const { product: revised } = await json(`/api/catalog/${product.id}`, {
    sku: product.sku, nameZh: '新款骨瓷茶杯', nameEn: 'New Tea Cup', image: replacement.toString('base64'),
    revision: product.revision,
  });
  const productImage = await request(`/api/catalog/${product.id}/image`);
  assert.equal(productImage.headers.get('content-type'), 'image/png');
  assert.ok(productImage.bytes.equals(replacement));
  assertErrorMessage(await json(path('/api/product/from-library', second), selection, 409), /已更新/);
  assert.equal((await json(path('/api/workspace', second))).revision, 0);

  const secondAdoption = await json(path('/api/product/from-library', second), { ...selection, libraryRevision: revised.revision });
  assert.equal(secondAdoption.workspace.kit.product.nameZh, revised.nameZh);
  assert.notEqual(secondAdoption.workspace.selected.source, adopted.workspace.selected.source);
  const firstAgain = await json(path('/api/workspace'));
  assert.equal(firstAgain.kit.product.nameZh, product.nameZh);
  assert.equal(firstAgain.selected.source, adopted.workspace.selected.source);

  const firstReimport = await json(path('/api/product/from-library'), {
    revision: version.workspace.revision, libraryId: product.id, libraryRevision: revised.revision,
  });
  assert.notEqual(firstReimport.workspace.selected.source, adopted.workspace.selected.source);
  assert.ok(firstReimport.workspace.assets.some(item => item.id === adopted.workspace.selected.source));
  assert.equal(firstReimport.workspace.versions[0].snapshot.product.nameZh, product.nameZh);
  assert.ok((await request(path('/api/versions/1/pdf'))).bytes.equals(firstPdf.bytes));
});

const providerResultUrl = 'https://porvia-test.oss-cn-hangzhou.aliyuncs.com/result.jpg';

function exampleProviderResponse() {
  return Response.json({
    request_id: 'mock-provider-1',
    output: { choices: [{ message: { content: [{ image: providerResultUrl }] } }] },
  });
}

test('persists private model settings across restarts and uses the saved key for later model requests', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'porvia-model-settings-test-'));
  const source = getAssetImage('source-146');
  const authorizations = [];
  const fetcher = async (url, options) => {
    if (options.method === 'POST') {
      authorizations.push(options.headers.Authorization);
      return exampleProviderResponse();
    }
    assert.equal(String(url), providerResultUrl);
    return new Response(source);
  };
  const envFallback = 'example-env-fallback';
  const saved = 'example-saved-key';
  const model = 'qwen-image-2.1-turbo';
  const status = '/api/settings/model';
  const options = { dataDir, sceneFetcher: fetcher, packagingFetcher: fetcher };
  let first;
  let restarted;
  try {
    first = await startWorkspace(t, { ...options, apiKey: envFallback });
    assert.deepEqual(await first.json(status), { configured: true, savedLocally: false, model });
    for (const apiKey of [null, '  ', 'example invalid', 'example\u0000invalid', 'a'.repeat(513)]) {
      assertErrorMessage(await first.json(status, { apiKey }, 422), /API Key/);
    }
    assert.equal(authorizations.length, 0);
    const original = await first.json('/api/workspace');
    const scene = { sourceId: original.selected.source, scene: 'hotel-breakfast', confirmed: true, revision: original.revision };
    await first.json('/api/scenes', { ...scene, requestId: randomUUID() });
    assert.deepEqual(authorizations, [`Bearer ${envFallback}`]);

    assert.deepEqual(await first.json(status, { apiKey: ` ${saved}  ` }), { configured: true, savedLocally: true, model });
    assert.equal(authorizations.length, 1);
    const mode = (await stat(join(dataDir, 'model-api-key'))).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600);
    assert.ok((await readdir(dataDir)).every(name => !/^\.model-key-/.test(name)));
    const workspace = await first.request('/api/workspace');
    assert.equal(JSON.parse(workspace.bytes).sceneModelAvailable, true);
    assert.equal(JSON.parse(workspace.bytes).modelAvailable, true);
    assert.ok(!workspace.bytes.includes(saved));
    assert.ok(!(await first.request(status)).bytes.includes(saved));
    await first.json('/api/packaging/A', { mode: 'model', confirmed: true, requestId: randomUUID() });
    assert.equal(authorizations.at(-1), `Bearer ${saved}`);

    await first.close();
    restarted = await startWorkspace(t, { ...options, apiKey: 'different-env-example' });
    assert.deepEqual(await restarted.json(status), { configured: true, savedLocally: true, model });
    await restarted.json('/api/scenes', { ...scene, requestId: randomUUID() });
    assert.deepEqual(authorizations, [`Bearer ${envFallback}`, `Bearer ${saved}`, `Bearer ${saved}`]);
    if (process.platform !== 'win32') {
      const path = join(dataDir, 'model-api-key');
      await chmod(path, 0o644);
      assert.deepEqual(await restarted.json(status), { configured: true, savedLocally: false, model });
      assert.equal((await restarted.json('/api/workspace')).modelAvailable, true);
      await restarted.json(status, { apiKey: saved });
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    await first?.close();
    await restarted?.close();
    await rm(dataDir, { force: true, recursive: true });
  }
});

test('blank-project packaging generation uses current references and preserves earlier selections and PDFs', async t => {
  const sourceBytes = getAssetImage('source-146');
  const printBytes = getAssetImage('print-a-kit');
  const calls = [];
  const packagingFetcher = async (url, options) => {
    if (options.method === 'POST') {
      calls.push(JSON.parse(options.body).input.messages[0].content);
      return exampleProviderResponse();
    }
    assert.equal(String(url), providerResultUrl);
    return new Response(sourceBytes);
  };
  const { json, request } = await startWorkspace(t, { apiKey: 'test-packaging-key', packagingFetcher });
  const { project } = await json('/api/projects', { name: 'Custom tea cup', requestId: randomUUID() }, 201);
  const scoped = path => `${path}?project=${project.id}`;
  let current = await json(scoped('/api/workspace'));
  assert.equal(current.modelAvailable, true);
  const generation = { requestId: randomUUID(), mode: 'model', confirmed: true, brief: 'Warm gray box with a plain finish.' };
  const generate = (option, fields = {}, status = 200) => json(scoped(`/api/packaging/${option}`), {
    ...generation, revision: current.revision, sourceId: current.selected.source, ...fields,
  }, status);
  assertErrorMessage(await generate('A', {}, 422), /商品主图/);
  assertErrorMessage(await generate('A', { confirmed: false }, 422), /确认/);

  const product = { sku: 'TEA-165', nameZh: '茶杯', nameEn: 'Tea Cup' };
  current = (await json(scoped('/api/product'), { revision: current.revision, ...product })).workspace;
  current = (await json(scoped('/api/product/images/source'), {
    revision: current.revision, image: sourceBytes.toString('base64'),
  })).workspace;
  current = (await json(scoped('/api/inquiry'), {
    revision: current.revision, text: 'Please quote 150 sets with Print A for the hotel.',
  })).workspace;
  current = (await json(scoped('/api/inquiry/continue'), { revision: current.revision })).workspace;
  assert.equal(current.scenePrintMode, 'required');
  assertErrorMessage(await generate('A', { revision: 0 }, 409), /工作台已有更新/);
  assertErrorMessage(await generate('A', { sourceId: 'source-146' }, 409), /主图已更换/);
  assertErrorMessage(await generate('A', {}, 422), /选入印花稿/);

  current = (await json(scoped('/api/product/images/artwork'), {
    revision: current.revision, image: printBytes.toString('base64'),
  })).workspace;
  const print = await json(scoped('/api/prints/A'), {
    revision: current.revision, position: { centerX: 0.5, centerY: 0.5, widthRatio: 0.2, rotationDegrees: 0 },
    image: printBytes.toString('base64'),
  });
  current = print.workspace;
  assertErrorMessage(await generate('A', { printAssetId: print.result.id }, 422), /当前已选中的印花稿/);
  current = (await json(scoped('/api/select'), {
    revision: current.revision, slot: 'printA', assetId: print.result.id,
  })).workspace;
  assert.equal(calls.length, 0);
  const generated = await generate('A', { printAssetId: print.result.id });
  const candidate = generated.result;
  current = generated.workspace;
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, -1).map(item => item.image), [
    `data:image/jpeg;base64,${sourceBytes.toString('base64')}`,
    `data:image/png;base64,${printBytes.toString('base64')}`,
  ]);
  assert.match(calls[0].at(-1).text, /Warm gray box/);
  assert.doesNotMatch(calls[0].at(-1).text, /Longway 146|rounded-square|lemon/i);
  assert.equal(candidate.sourceId, current.selected.source);
  assert.equal(candidate.printAssetId, print.result.id);
  assert.equal(candidate.productSku, product.sku);
  assert.equal(candidate.kind, 'model_preview');
  assert.equal(current.selected.packA, null);
  assert.equal(current.jobs.find(job => job.assetId === candidate.id).sourceId, current.selected.source);
  assertErrorMessage(await json(scoped('/api/select'), {
    revision: current.revision, slot: 'packA', assetId: candidate.id,
  }, 422), /先完成.*审核/);
  const review = { assetId: candidate.id, status: 'approved', checked: true };
  current = (await json(scoped('/api/packaging/A/review'), { revision: current.revision, ...review })).workspace;
  current = (await json(scoped('/api/select'), {
    revision: current.revision, slot: 'packA', assetId: candidate.id,
  })).workspace;
  const upload = await json(scoped('/api/packaging/B'), { mode: 'upload', requestId: randomUUID(), image: sourceBytes.toString('base64') });
  current = (await json(scoped('/api/packaging/B/review'), {
    revision: upload.workspace.revision, assetId: upload.result.id, status: 'approved', checked: true,
  })).workspace;
  current = (await json(scoped('/api/select'), {
    revision: current.revision, slot: 'packB', assetId: upload.result.id,
  })).workspace;
  current = (await json(scoped('/api/versions'), { revision: current.revision, requestId: randomUUID() })).workspace;
  assert.equal(current.versions[0].snapshot.selections.packA.id, candidate.id);
  const original = await request(scoped('/api/versions/1/pdf'));

  current = (await json(scoped('/api/product'), {
    revision: current.revision, ...product, sku: 'TEA-166',
  })).workspace;
  assert.equal(current.selected.packA, null);
  assert.equal(current.selected.packB, upload.result.id);
  assert.equal(current.assets.find(item => item.id === candidate.id).packStale, true);
  assertErrorMessage(await json(scoped('/api/packaging/A/review'), { revision: current.revision, ...review }, 422), /包装图与当前/);
  assertErrorMessage(await json(scoped('/api/select'), {
    revision: current.revision, slot: 'packA', assetId: candidate.id,
  }, 422), /包装图与当前/);
  current = (await json(scoped('/api/versions'), { revision: current.revision, requestId: randomUUID() })).workspace;
  assert.equal(current.versions[0].snapshot.selections.packA, null);
  assert.equal(current.versions[0].snapshot.selections.packB.id, upload.result.id);
  assert.ok((await request(scoped('/api/versions/1/pdf'))).bytes.equals(original.bytes));
});

test('template packaging generation still uses its established kit references', async t => {
  const packagingFetcher = async (url, options) => {
    if (options.method === 'POST') {
      const content = JSON.parse(options.body).input.messages[0].content;
      assert.equal(content.length, 5);
      assert.match(content.at(-1).text, /Longway 146/);
      return exampleProviderResponse();
    }
    assert.equal(String(url), providerResultUrl);
    return new Response(getAssetImage('source-146'));
  };
  const { json } = await startWorkspace(t, { apiKey: 'test-packaging-key', packagingFetcher });
  const generated = await json('/api/packaging/B', {
    mode: 'model', confirmed: true, requestId: randomUUID(),
  });
  assert.equal(generated.result.kind, 'model_preview');
  assert.equal(generated.result.sourceId, undefined);
  assert.equal(generated.workspace.selected.packB, 'pack-b-kit');
});

test('generates scene candidates from current project references and exports only the selected scene', async t => {
  const sourceBytes = getAssetImage('source-146');
  const printBytes = getAssetImage('print-a-kit');
  const requests = [];
  const sceneFetcher = async (url, options) => {
    if (options.method === 'POST') {
      requests.push(JSON.parse(options.body));
      return exampleProviderResponse();
    }
    assert.equal(String(url), providerResultUrl);
    return new Response(sourceBytes);
  };
  const { json, request } = await startWorkspace(t, { apiKey: 'test-scene-key', sceneFetcher });
  const { project } = await json('/api/projects', { name: 'Tea service', requestId: randomUUID() }, 201);
  const scoped = path => `${path}?project=${project.id}`;
  const initial = await json(scoped('/api/workspace'));
  assert.equal(initial.sceneModelAvailable, true);
  assert.equal(initial.modelAvailable, true);
  assert.deepEqual(initial.scenePresets.map(item => item.id), ['hotel-breakfast', 'afternoon-tea', 'cafe', 'custom']);
  const generation = {
    requestId: randomUUID(), revision: initial.revision, confirmed: true, sourceId: 'source-146',
    scene: 'afternoon-tea', brief: 'Use soft afternoon light.',
  };
  assertErrorMessage(await json(scoped('/api/scenes'), generation, 422), /商品主图/);
  const product = await json(scoped('/api/product'), {
    revision: initial.revision, sku: 'TEA-165', nameZh: '茶杯', nameEn: 'Tea Cup',
  });
  const source = await json(scoped('/api/product/images/source'), {
    revision: product.workspace.revision, filename: 'cup.jpg', image: sourceBytes.toString('base64'),
  });
  const artwork = await json(scoped('/api/product/images/artwork'), {
    revision: source.workspace.revision, filename: 'artwork.png', image: printBytes.toString('base64'),
  });
  const print = await json(scoped('/api/prints/A'), {
    revision: artwork.workspace.revision, position: { centerX: 0.5, centerY: 0.5, widthRatio: 0.2, rotationDegrees: 0 },
    image: printBytes.toString('base64'),
  });
  const references = { ...generation, revision: print.workspace.revision, sourceId: source.result.id, printAssetId: print.result.id };
  assertErrorMessage(await json(scoped('/api/scenes'), references, 422), /当前已选中的印花稿/);
  const selectedPrint = await json(scoped('/api/select'), {
    revision: print.workspace.revision, slot: 'printA', assetId: print.result.id,
  });
  const body = { ...references, revision: selectedPrint.workspace.revision };
  assertErrorMessage(await json(scoped('/api/scenes'), { ...body, confirmed: false }, 422), /确认/);
  assertErrorMessage(await json(scoped('/api/scenes'), { ...body, scene: 'custom', brief: ' ' }, 422), /场景要求/);
  assertErrorMessage(await json(scoped('/api/scenes'), { ...body, sourceId: 'source-146' }, 409), /主图已更换/);
  assert.equal(requests.length, 0);
  const generated = await json(scoped('/api/scenes'), body);
  assert.equal(requests.length, 1);
  const content = requests[0].input.messages[0].content;
  assert.deepEqual(content.slice(0, 2).map(item => item.image), [
    `data:image/jpeg;base64,${sourceBytes.toString('base64')}`,
    `data:image/png;base64,${printBytes.toString('base64')}`,
  ]);
  assert.match(content.at(-1).text, /afternoon-tea/);
  assert.equal(generated.workspace.revision, body.revision);
  assert.equal(generated.workspace.selected.lifestyle, null);
  assert.equal(generated.result.kind, 'model_preview');
  assert.equal(generated.result.slot, 'lifestyle');
  assert.equal(generated.result.sourceId, source.result.id);
  assert.equal(generated.result.printAssetId, print.result.id);
  assert.equal(generated.result.productSku, 'TEA-165');
  assert.equal(generated.workspace.jobs[0].scene, body.scene);
  assert.equal(generated.workspace.jobs[0].brief, body.brief);
  assert.equal(generated.workspace.jobs[0].status, 'succeeded');
  assert.equal(generated.workspace.jobs[0].assetId, generated.result.id);
  assert.ok((await request(scoped(`/api/assets/${generated.result.id}`))).bytes.equals(sourceBytes));

  const candidateOnly = await json(scoped('/api/versions'), { revision: body.revision, requestId: randomUUID() });
  assert.equal(candidateOnly.workspace.versions[0].snapshot.selections.lifestyle, null);
  const adopted = await json(scoped('/api/select'), {
    revision: candidateOnly.workspace.revision, slot: 'lifestyle', assetId: generated.result.id,
  });
  const withScene = await json(scoped('/api/versions'), { revision: adopted.workspace.revision, requestId: randomUUID() });
  assert.equal(withScene.workspace.versions[0].snapshot.selections.lifestyle.id, generated.result.id);
  const pdf = await request(scoped('/api/versions/2/pdf'));
  assert.ok(pdf.bytes.includes(Buffer.from('AI-GENERATED CONCEPT')), 'PDF labels the scene as AI-generated');

  const withoutPrint = await json(scoped('/api/select'), {
    revision: withScene.workspace.revision, slot: 'printA', assetId: null,
  });
  assert.equal(withoutPrint.workspace.selected.lifestyle, null);
  assert.equal(withoutPrint.workspace.assets.find(asset => asset.id === generated.result.id).sceneStale, true);
  const restoredPrint = await json(scoped('/api/select'), {
    revision: withoutPrint.workspace.revision, slot: 'printA', assetId: print.result.id,
  });
  const restoredScene = await json(scoped('/api/select'), {
    revision: restoredPrint.workspace.revision, slot: 'lifestyle', assetId: generated.result.id,
  });
  const replacement = await json(scoped('/api/product/images/source'), {
    revision: restoredScene.workspace.revision, filename: 'updated-cup.jpg', image: sourceBytes.toString('base64'),
  });
  assert.equal(replacement.workspace.selected.lifestyle, null);
  assert.equal(replacement.workspace.assets.find(asset => asset.id === generated.result.id).sceneStale, true);
  assertErrorMessage(await json(scoped('/api/select'), {
    revision: replacement.workspace.revision, slot: 'lifestyle', assetId: generated.result.id,
  }, 422), /场景图与当前/);
  const afterChange = await json(scoped('/api/versions'), {
    revision: replacement.workspace.revision, requestId: randomUUID(),
  });
  assert.equal(afterChange.workspace.versions[0].snapshot.selections.lifestyle, null);
  assert.ok((await request(scoped('/api/versions/2/pdf'))).bytes.equals(pdf.bytes));
});

test('scene generation follows the adopted print requirement and keeps earlier proposals', async t => {
  const source = getAssetImage('source-146');
  let submissions = 0;
  const sceneFetcher = async (url, options) => {
    if (options.method === 'POST') {
      submissions++;
      return exampleProviderResponse();
    }
    assert.equal(String(url), providerResultUrl);
    return new Response(source);
  };
  const { json, request } = await startWorkspace(t, { apiKey: 'test-scene-key', sceneFetcher });
  const initial = await json('/api/workspace');
  assert.equal(initial.scenePrintMode, 'optional');
  const generate = {
    sourceId: initial.selected.source, scene: 'hotel-breakfast', confirmed: true,
  };
  const unprinted = await json('/api/scenes', { ...generate, revision: initial.revision, requestId: randomUUID() });
  const selected = await json('/api/select', {
    revision: initial.revision, slot: 'lifestyle', assetId: unprinted.result.id,
  });
  const saved = await json('/api/versions', { revision: selected.workspace.revision, requestId: randomUUID() });
  const originalPdf = await request('/api/versions/1/pdf');

  const extracted = await json('/api/inquiry', {
    revision: saved.workspace.revision, text: 'Please quote 150 sets with Print A for the hotel.',
  });
  assert.equal(extracted.result.print, 'print-a');
  assert.equal(extracted.workspace.scenePrintMode, 'optional');
  assert.equal(extracted.workspace.selected.lifestyle, unprinted.result.id);
  const adopted = await json('/api/inquiry/continue', { revision: extracted.workspace.revision });
  assert.equal(adopted.workspace.scenePrintMode, 'required');
  assert.equal(adopted.workspace.selected.lifestyle, null);
  assert.equal(adopted.workspace.assets.find(item => item.id === unprinted.result.id).sceneStale, true);
  assertErrorMessage(await json('/api/scenes', {
    ...generate, revision: adopted.workspace.revision, requestId: randomUUID(),
  }, 422), /先在.*印花设计.*选入印花稿/);
  assert.equal(submissions, 1);
  const printAssetId = adopted.workspace.selected.printA;
  const printed = await json('/api/scenes', {
    ...generate, revision: adopted.workspace.revision, printAssetId, requestId: randomUUID(),
  });
  assert.equal(printed.result.printAssetId, printAssetId);
  const selectedPrint = await json('/api/select', {
    revision: printed.workspace.revision, slot: 'lifestyle', assetId: printed.result.id,
  });

  const reviewed = await json('/api/inquiry/review', {
    revision: selectedPrint.workspace.revision, fields: { print: '不印花' },
  });
  const plain = await json('/api/inquiry/continue', { revision: reviewed.workspace.revision });
  assert.equal(plain.workspace.scenePrintMode, 'plain');
  assert.equal(plain.workspace.selected.lifestyle, null);
  assert.equal(plain.workspace.assets.find(item => item.id === printed.result.id).sceneStale, true);
  assertErrorMessage(await json('/api/scenes', {
    ...generate, revision: plain.workspace.revision, printAssetId, requestId: randomUUID(),
  }, 422), /要求无印花/);
  const noPrintReference = await json('/api/scenes', {
    ...generate, revision: plain.workspace.revision, requestId: randomUUID(),
  });
  assert.equal(noPrintReference.result.printAssetId, null);

  const english = await json('/api/inquiry/review', {
    revision: noPrintReference.workspace.revision, fields: { print: 'No Printing.' },
  });
  assert.equal((await json('/api/inquiry/continue', { revision: english.workspace.revision })).workspace.scenePrintMode, 'plain');
  assert.equal(submissions, 3);
  assert.ok((await request('/api/versions/1/pdf')).bytes.equals(originalPdf.bytes));
});

test('retains uploaded scenes in templates and stops duplicate and unresolved scene submissions', async t => {
  let entered;
  let release;
  const submitted = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  let submissions = 0;
  const source = getAssetImage('source-146');
  const sceneFetcher = async (url, options) => {
    if (options.method !== 'POST') {
      assert.equal(String(url), providerResultUrl);
      return new Response(source);
    }
    submissions++;
    if (submissions === 1) {
      entered();
      await waiting;
      throw new Error('Mock transport closed unexpectedly');
    }
    return exampleProviderResponse();
  };
  const { json } = await startWorkspace(t, { apiKey: 'test-scene-key', sceneFetcher });
  const initial = await json('/api/workspace');
  const uploaded = await json('/api/product/images/lifestyle', {
    revision: initial.revision, filename: 'existing-cover.jpg', image: source.toString('base64'),
  });
  assert.equal(uploaded.workspace.selected.lifestyle, uploaded.result.id);
  assert.equal(uploaded.result.kind, 'uploaded_preview');
  const body = {
    revision: uploaded.workspace.revision, requestId: randomUUID(), sourceId: initial.selected.source,
    scene: 'hotel-breakfast', confirmed: true,
  };
  const generating = json('/api/scenes', body, 409);
  try {
    await Promise.race([submitted, generating]);
    assert.equal((await json('/api/workspace')).jobs[0].status, 'running');
    assertErrorMessage(await json('/api/scenes', body, 409), /已记录/);
    assertErrorMessage(await json('/api/scenes', { ...body, requestId: randomUUID() }, 409), /场景图已有未确认/);
    assertErrorMessage(await json('/api/scenes/resolve', { requestId: body.requestId, providerChecked: true }, 422), /先核对/);
  } finally {
    release();
  }
  assertErrorMessage(await generating, /状态未确认/);
  assert.equal((await json('/api/workspace')).jobs[0].status, 'needs_review');
  assertErrorMessage(await json('/api/scenes', { ...body, requestId: randomUUID() }, 409), /场景图已有未确认/);
  assert.equal(submissions, 1);
  const resolved = await json('/api/scenes/resolve', { requestId: body.requestId, providerChecked: true });
  assert.equal(resolved.workspace.jobs[0].status, 'failed');
  const retried = await json('/api/scenes', { ...body, requestId: randomUUID() });
  assert.equal(retried.workspace.jobs[0].status, 'succeeded');
  assert.equal(retried.workspace.selected.lifestyle, uploaded.result.id);
  assert.equal(submissions, 2);
});

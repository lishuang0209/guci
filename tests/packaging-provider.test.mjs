import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { generateCustomPackagingImage, generatePackagingImage, generateSceneImage } from '../src/packaging-provider.mjs';

const kit = new URL('../Porvia-Development-Kit-Lemon/', import.meta.url);
const preset = JSON.parse(await readFile(new URL('03-packaging/pack-B-preset.json', kit), 'utf8'));
const product = await readFile(new URL(preset.productAsset, kit));
const visual = await readFile(new URL(preset.referenceAssets[0], kit));
const structure = await readFile(new URL(preset.referenceAssets[1], kit));
const artwork = await readFile(new URL(preset.graphicAsset, kit));
const references = [
  { role: 'product', bytes: product, mimeType: 'image/jpeg' },
  { role: 'approved-packaging', bytes: visual, mimeType: 'image/png' },
  { role: 'supplier-structure', bytes: structure, mimeType: 'image/jpeg' },
  { role: 'graphic', bytes: artwork, mimeType: 'image/png' },
];
const resultImageUrl = 'https://dashscope-result.oss-cn-beijing.aliyuncs.com/porvia.jpg?signature=example';

function providerResult(image = resultImageUrl) {
  return Response.json({
    request_id: 'porvia-example',
    output: { choices: [{ message: { content: [{ image }] } }] },
  });
}

test('submits the BeatDesign DashScope contract with ordered and distinct image roles', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1 ? providerResult() : new Response(product);
  };
  const result = await generatePackagingImage({
    preset, key: 'example-key', brief: '稍微提亮光线', references, fetcher,
  });

  assert.equal(calls.length, 2);
  const [submission, download] = calls;
  assert.equal(submission.url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(submission.init.method, 'POST');
  assert.equal(submission.init.redirect, 'error');
  assert.equal(submission.init.headers.Authorization, 'Bearer example-key');
  const request = JSON.parse(submission.init.body);
  assert.equal(request.model, 'qwen-image-2.1-turbo');
  assert.equal(request.parameters.n, 1);
  assert.equal(request.parameters.watermark, false);
  const content = request.input.messages[0].content;
  for (const [index, reference] of references.entries()) {
    assert.equal(content[index].image, `data:${reference.mimeType};base64,${reference.bytes.toString('base64')}`);
  }
  const { text } = content.at(-1);
  assert.match(text, /rigid lift-off-lid box/);
  assert.match(text, /Image 1\. The real product photo is the authority/);
  assert.match(text, /Image 2\. The approved packaging concept guides lighting/);
  assert.match(text, /Image 3\. The supplier packaging photo guides general box construction only/);
  assert.match(text, /Image 4\. The source artwork guides the box motif only/);
  assert.match(text, /exactly one real 146 cup and one real 146 rounded-square saucer/);
  assert.match(text, /Keep existing product decoration unchanged/);
  assert.match(text, /稍微提亮光线/);
  assert.equal(download.url, resultImageUrl);
  assert.equal(download.init.redirect, 'error');
  assert.equal(download.init.headers, undefined);
  assert.equal(result.requestId, 'porvia-example');
  assert.equal(result.mimeType, 'image/jpeg');
  assert.deepEqual(result.bytes, product);
});

test('uses the approved print only when supplied explicitly', async () => {
  const approvedPrint = { role: 'approved-print', bytes: artwork, mimeType: 'image/png' };
  const fetcher = async (url, init) => {
    if (init.method !== 'POST') return new Response(visual);
    const prompt = JSON.parse(init.body).input.messages[0].content.at(-1).text;
    assert.match(prompt, /approved Print A\/B placement preview guides cup decoration/);
    assert.match(prompt, /Use only the approved cup print/);
    assert.doesNotMatch(prompt, /Keep existing product decoration unchanged/);
    return providerResult();
  };
  assert.equal((await generatePackagingImage({
    preset, key: 'example-key', references: [...references, approvedPrint], fetcher,
  })).mimeType, 'image/png');
});

test('rejects missing, spoofed or unrecognized materials without a provider call', async () => {
  const fetcher = () => assert.fail('adapter contacted Bailian');
  for (const invalid of [
    references.slice(1),
    [{ ...references[0], mimeType: 'image/png' }, ...references.slice(1)],
    [...references, { ...references[0], role: 'unknown' }],
  ]) {
    await assert.rejects(generatePackagingImage({ preset, key: 'example-key', references: invalid, fetcher }),
      (error) => error.uncertain === false && Boolean(error.publicMessage));
  }
});

test('distinguishes a definite rejection from an ambiguous submission and never retries', async () => {
  const simulations = [
    { status: 401, body: { code: 'InvalidApiKey' }, uncertain: false },
    { status: 429, body: { code: 'Throttling' }, uncertain: false },
    { status: 503, body: { code: 'UpstreamUnavailable' }, uncertain: true },
    { status: 400, body: { code: 'InvalidRequest', output: { task_id: 'maybe-submitted' } }, uncertain: true },
    { networkError: new Error('must not appear in user output'), uncertain: true },
  ];
  for (const { status, body, networkError, uncertain } of simulations) {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      if (networkError) throw networkError;
      return Response.json(body, { status });
    };
    await assert.rejects(generatePackagingImage({
      preset, key: 'example-key', references, fetcher,
    }), (error) => error.uncertain === uncertain && !error.publicMessage.includes('must not appear'));
    assert.equal(calls, 1);
  }
});

test('an unsafe URL or invalid output stays ambiguous after the billed request', async () => {
  let calls = 0;
  await assert.rejects(generatePackagingImage({
    preset, key: 'example-key', references,
    fetcher: async () => {
      calls++;
      return providerResult('https://oss-cn-beijing.aliyuncs.com.example.test/result.png');
    },
  }), (error) => error.uncertain === true && error.requestId === 'porvia-example');
  assert.equal(calls, 1);

  await assert.rejects(generatePackagingImage({
    preset, key: 'example-key', references,
    fetcher: async (url, init) => init.method === 'POST' ? providerResult() : new Response('not an image'),
  }), (error) => error.uncertain === true && error.requestId === 'porvia-example');
});

test('generates both box types from the current product and applies only the selected print', async () => {
  const source = references[0];
  const print = { role: 'approved-print', bytes: artwork, mimeType: 'image/png' };
  for (const [option, boxType] of [['A', /Folding carton/], ['B', /Rigid gift box/]]) {
    const supplied = option === 'A' ? [source] : [source, print];
    const result = await generateCustomPackagingImage({
      option, brief: '奶油白外盒', references: supplied, key: 'example-key',
      fetcher: async (_url, init) => {
        if (init.method !== 'POST') return new Response(product);
        const content = JSON.parse(init.body).input.messages[0].content;
        assert.equal(content.length, supplied.length + 1);
        for (const [index, ref] of supplied.entries()) {
          assert.equal(content[index].image, `data:${ref.mimeType};base64,${ref.bytes.toString('base64')}`);
        }
        const { text } = content.at(-1);
        assert.match(text, boxType);
        assert.match(text, /奶油白外盒/);
        assert.match(text, /same product pieces and count as in the main photo/);
        assert.match(text, /presentation concept only/);
        assert.match(text, option === 'A' ? /Preserve the product decoration as photographed/ : /Apply the approved print/);
        assert.doesNotMatch(text, /Longway 146|rounded-square saucer/);
        return providerResult();
      },
    });
    assert.equal(result.mimeType, 'image/jpeg');
    assert.deepEqual(result.bytes, product);
  }
});

test('rejects unknown box types and missing or duplicate product references before generation', async () => {
  const call = { option: 'A', key: 'example-key', references: [references[0]] };
  for (const invalid of [
    { option: 'constructor' },
    { references: [{ role: 'approved-print', bytes: artwork, mimeType: 'image/png' }] },
    { references: [references[0], references[0]] },
    { references: [references[0], references[1]] },
  ]) {
    await assert.rejects(generateCustomPackagingImage({
      ...call, ...invalid, fetcher: () => assert.fail('adapter contacted Bailian'),
    }), (error) => error.uncertain === false && Boolean(error.publicMessage));
  }
});

test('generates a scene in the selected setting using the current product and its optional print', async () => {
  const mainPhoto = product;
  const print = await readFile(new URL('02-artwork/146-print-A-ai-preview.png', kit));
  const call = {
    scene: 'afternoon-tea', brief: '自然光下的浅色木桌', key: 'example-key',
    references: [
      { role: 'product', bytes: mainPhoto, mimeType: 'image/jpeg' },
      { role: 'approved-print', bytes: print, mimeType: 'image/png' },
    ],
  };
  const calls = [];
  const result = await generateSceneImage({
    ...call,
    fetcher: async (url, init) => {
      calls.push({ url: String(url), init });
      return calls.length === 1 ? providerResult() : new Response(mainPhoto);
    },
  });
  assert.equal(calls.length, 2);
  const request = JSON.parse(calls[0].init.body);
  assert.equal(request.parameters.size, '1360*768');
  const [source, decoration, prompt] = request.input.messages[0].content;
  assert.equal(source.image, `data:image/jpeg;base64,${mainPhoto.toString('base64')}`);
  assert.equal(decoration.image, `data:image/png;base64,${print.toString('base64')}`);
  assert.match(prompt.text, /afternoon-tea table/);
  assert.match(prompt.text, /Image 1\. The selected main product photo is the authority/);
  assert.match(prompt.text, /Image 2\. The approved print preview guides the decoration and placement only/);
  assert.match(prompt.text, /自然光下的浅色木桌/);
  assert.doesNotMatch(prompt.text, /Longway 146|rounded-square saucer|box construction/);
  assert.deepEqual(result, { bytes: mainPhoto, mimeType: 'image/jpeg', requestId: 'porvia-example' });
});

test('uses the custom description and keeps the photographed decoration when no print is selected', async () => {
  await generateSceneImage({
    scene: 'custom', key: 'example-key', brief: '极简茶台，窗外绿植',
    references: [references[0]],
    fetcher: async (url, init) => {
      if (init.method !== 'POST') return new Response(product);
      const content = JSON.parse(init.body).input.messages[0].content;
      assert.equal(content.length, 2);
      assert.match(content[1].text, /极简茶台，窗外绿植/);
      assert.match(content[1].text, /Preserve the product decoration as photographed/);
      return providerResult();
    },
  });
});

test('rejects invalid scene settings and duplicate or unrelated references before calling Bailian', async () => {
  const call = { scene: 'cafe', key: 'example-key', references: [references[0]] };
  for (const invalid of [
    { scene: 'constructor' },
    { scene: 'custom' },
    { references: [references[0], references[0]] },
    { references: [references[1]] },
    { references: [{ ...references[0], mimeType: 'image/png' }] },
  ]) {
    await assert.rejects(generateSceneImage({
      ...call, ...invalid, fetcher: () => assert.fail('adapter contacted Bailian'),
    }), (error) => error.uncertain === false && Boolean(error.publicMessage));
  }
});

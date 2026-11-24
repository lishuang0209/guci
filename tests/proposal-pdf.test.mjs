import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { createProposalPdf } from '../src/proposal-pdf.mjs';
import { describeImage } from '../src/proposal-pdf-images.mjs';

const kit = new URL('../Porvia-Development-Kit-Lemon/', import.meta.url);
const read = (path) => readFile(new URL(path, kit));
const loadJson = async (path) => JSON.parse(await read(path));
const [product, buyer, A, B] = await Promise.all([
  loadJson('01-product/product-146.json'), loadJson('04-tests/demo-proposal.json'),
  loadJson('03-packaging/pack-A-preset.json'), loadJson('03-packaging/pack-B-preset.json'),
]);
const asset = (id, path, kind = 'ai_preview') => ({ id, label: id, path, kind });
const proposal = {
  id: buyer.id, version: 1, collection: buyer.collection, buyer, product, packPresets: { A, B },
  selections: {
    lifestyle: asset('lifestyle', '03-packaging/lifestyle-approved-visual.png'),
    source: asset('source', '01-product/146-source.jpg', 'supplier_photo'),
    printA: asset('print-a', '02-artwork/146-print-A-ai-preview.png'),
    printB: asset('print-b', '02-artwork/146-print-B-ai-preview.png'),
    packA: asset('pack-a', '03-packaging/pack-A-approved-visual.png'),
    packB: asset('pack-b', '03-packaging/pack-B-approved-visual.png'),
  },
};

function text(bytes) {
  return bytes.toString('latin1');
}

function validateDocument(contents, number, packagingConfirmed = false) {
  assert.ok(contents.startsWith('%PDF-1.4'));
  assert.match(contents, /\/Type \/Pages \/Count 4\b/);
  assert.equal([...contents.matchAll(/\/Type \/Page \/Parent /g)].length, 4);
  assert.equal(contents.match(/\(BUYER PROPOSAL \/ DEMO-001 \/ V\d+\) Tj/g)?.length, 4);
  assert.ok(contents.includes(`(BUYER PROPOSAL / DEMO-001 / V${number}) Tj`));
  assert.ok(contents.includes('https://luxurybonechina.com/Products/fine-bone-china-cup-saucer-set/'));
  assert.ok(contents.includes('Final dimensions, materials and insert fit are subject to factory confirmation.'));
  const packagingRequest = packagingConfirmed ? '' : ' Pack A or B,';
  assert.ok(contents.includes(`Reply with model 146, Print A or B,${packagingRequest} and your estimated order quantity.`));
  const xref = Number(/startxref\n(\d+)\n%%EOF/.exec(contents)[1]);
  assert.equal(contents.slice(xref, xref + 4), 'xref');
  const entries = [...contents.slice(xref).matchAll(/^(\d{10}) 00000 n /gm)];
  entries.forEach((entry, index) => assert.ok(contents.startsWith(`${index + 1} 0 obj`, Number(entry[1]))));
}

test('exports four English pages with supplier provenance and the selected asset list', async () => {
  const readIds = [];
  const data = await createProposalPdf(proposal, (item) => {
    readIds.push(item.id);
    return read(item.path);
  });
  assert.deepEqual(readIds, ['lifestyle', 'source', 'print-a', 'print-b', 'pack-a', 'pack-b']);
  const contents = text(data);
  validateDocument(contents, 1);
  assert.equal([...contents.matchAll(/\/Subtype \/Image /g)].length, readIds.length);
  assert.ok(contents.includes('Supplier product photograph'.toUpperCase()));
  assert.ok(contents.includes('AI-generated concept'));
});

test('renders an empty slot without falling back to an unselected preview and embeds transparent art', async () => {
  const revised = structuredClone(proposal);
  revised.version = 2;
  revised.selections.printB = null;
  revised.selections.printA = asset('overlay', '02-artwork/lemon-blue-flowers-original.png', 'local_overlay');
  const readIds = [];
  const exportData = await createProposalPdf(revised, (item) => {
    readIds.push(item.id);
    return read(item.path);
  });
  const contents = text(exportData);
  assert.deepEqual(readIds, ['lifestyle', 'source', 'overlay', 'pack-a', 'pack-b']);
  validateDocument(contents, 2);
  assert.ok(contents.includes('/SMask '));
  assert.ok(contents.includes('No image selected'));
  assert.ok(contents.includes('Digital artwork placement preview'));
});

test('shows pending use and quantity in a packaging-first proposal', async () => {
  const draft = {
    ...proposal,
    version: 3,
    buyer: { use: null, quantity: null, quantityQualifier: '', quantityUnit: 'sets', packaging: ['gift box'] },
  };
  const contents = text(await createProposalPdf(draft, (item) => read(item.path)));
  validateDocument(contents, 3);
  assert.match(contents, /\(Bone china buyer proposal\) Tj/);
  assert.match(contents, /\(Intended use to be confirmed\) Tj/);
  assert.match(contents, /\(Order quantity to be confirmed\) Tj/);
  assert.doesNotMatch(contents, /hotel breakfast|planned order|500 sets/i);
});

test('acknowledges the buyer packaging choice and retains factory confirmation as pending', async () => {
  for (const [choice, confirmation] of [
    ['pack-b', 'The buyer confirmed Pack B'],
    ['硬质礼盒', 'The buyer confirmed a rigid gift box for model 146.'],
    ['定制抽屉盒', "The buyer's packaging choice for model 146 has been recorded."],
  ]) {
    const draft = { ...proposal, version: 4, buyer: { ...buyer, packagingConfirmed: true, packaging: [choice] } };
    const contents = text(await createProposalPdf(draft, (item) => read(item.path)));
    validateDocument(contents, 4, true);
    assert.ok(contents.includes('Packaging choice confirmed'));
    assert.ok(contents.includes(confirmation));
    assert.ok(contents.includes('Confirm model 146, then choose your preferred print option.'));
    assert.doesNotMatch(contents, /Choose a packaging direction|Pack A or B|preferred print and packaging options/);
    assert.equal([...contents.matchAll(/\/Subtype \/Image /g)].length, 6);
  }
});

test('exports a blank project with its own product and selections and keeps unfilled facts pending', async () => {
  const project = {
    projectMode: 'blank', id: '8bf2b627-6f45-4e50-a7e5-ebd2fc7fd5d4', version: 1,
    collection: 'Harbor Service',
    product: { sku: 'HBR-015', nameEn: 'Harbor Dinner Plate', supplier: 'Harbor Pottery' },
    buyer: { use: null, quantity: null, packaging: ['pack-b'], packagingConfirmed: true },
    packPresets: { A, B },
    selections: {
      source: asset('harbor-source', '01-product/146-source.jpg', 'uploaded_preview'),
      printA: asset('harbor-print', '02-artwork/lemon-blue-flowers-original.png', 'uploaded_preview'),
    },
  };
  const readIds = [];
  const contents = text(await createProposalPdf(project, (item) => {
    readIds.push(item.id);
    return read(item.path);
  }));
  assert.deepEqual(readIds, ['harbor-source', 'harbor-print']);
  assert.match(contents, /\/Type \/Pages \/Count 4\b/);
  assert.equal([...contents.matchAll(/\/Type \/Page \/Parent /g)].length, 4);
  assert.equal(contents.match(/\(BUYER PROPOSAL \/ 8BF2B627 \/ V1\) Tj/g)?.length, 4);
  for (const label of ['Harbor Service', 'Harbor Dinner Plate', 'Harbor Pottery', 'HBR-015', 'Order quantity to be confirmed',
    'Intended use to be confirmed', 'Pending', 'User-provided concept image', 'No image selected', 'The buyer confirmed Pack B.']) {
    assert.ok(contents.includes(`(${label}) Tj`) || contents.includes(` / ${label}) Tj`), label);
  }
  assert.doesNotMatch(contents, /DEMO-001|Lemon|Longway|luxurybonechina|Folding Carton|Rigid Gift Box|square saucer|210 mL|500 sets/i);
});

test('rejects missing and undecodable selected files with the affected asset label', async () => {
  await assert.rejects(createProposalPdf(proposal, () => read('missing.jpg')), /Cannot export lifestyle: the selected image file is missing/);
  await assert.rejects(createProposalPdf(proposal, () => Buffer.from('wrong')), /Cannot export lifestyle: The selected image must be a PNG or JPEG file/);
  assert.throws(() => describeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01])), /JPEG could not be decoded/);
});

test('places Adam7 RGBA samples in their original rows and retains alpha', () => {
  const pixels = Array.from({ length: 16 }, (_, i) => [17 * i, 120, 200 - i, 255 - 13 * i]);
  const rows = [[0], [2], [8, 10], [1, 3], [9, 11], [4, 5, 6, 7], [12, 13, 14, 15]];
  const interlaced = Buffer.from(rows.flatMap(row => [0, ...row.flatMap(index => pixels[index])]));
  const header = Buffer.from([0, 0, 0, 4, 0, 0, 0, 4, 8, 6, 0, 0, 1]);
  const chunk = (label, bytes) => {
    const payload = Buffer.concat([Buffer.from(label), bytes]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(payload));
    return Buffer.concat([size, payload, checksum]);
  };
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(interlaced)), chunk('IEND', Buffer.alloc(0))]);
  const image = describeImage(png);
  assert.deepEqual(inflateSync(image.bytes), Buffer.from(pixels.flatMap(pixel => pixel.slice(0, 3))));
  assert.deepEqual(inflateSync(image.alpha.bytes), Buffer.from(pixels.map(pixel => pixel[3])));
});

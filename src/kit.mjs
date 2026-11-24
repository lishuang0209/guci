import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const kitRoot = resolve(root, 'Porvia-Development-Kit-Lemon');

function kitPath(path) {
  const resolved = resolve(kitRoot, path);
  if (!resolved.startsWith(kitRoot + sep)) throw new Error('素材引用超出开发包目录。');
  return resolved;
}

export const readKit = path => readFileSync(kitPath(path));
const json = path => JSON.parse(readKit(path));
const media = (id, path, label, kind, slot = null) => ({
  id, path, label, kind, slot,
  mimeType: path.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
  filename: path.split('/').at(-1),
});

const print = json('02-artwork/print-options.json');
const packPresets = {
  A: json('03-packaging/pack-A-preset.json'),
  B: json('03-packaging/pack-B-preset.json'),
};

export const kit = {
  product: json('01-product/product-146.json'),
  print,
  packPresets,
  factory: json('06-factory/production-fields.json'),
  demo: json('04-tests/demo-proposal.json'),
  cases: json('04-tests/inquiry-cases.json').cases.map(({ id, input }) => ({ id, input })),
  assets: [
    media('source-146', print.baseImage, '146 自制示意图', 'demo_illustration', 'source'),
    media('source-collage', '01-product/146-source-collage.jpg', '146 自制示意图拼图', 'demo_illustration'),
    media('lemon-original', print.artwork, '柠檬蓝花透明原稿', 'artwork'),
    media('print-a-kit', print.visualPreviews['print-a'], 'Print A · 自制演示稿', 'demo_illustration', 'printA'),
    media('print-b-kit', print.visualPreviews['print-b'], 'Print B · 自制演示稿', 'demo_illustration', 'printB'),
    media('pack-a-kit', packPresets.A.referenceAssets[0], 'Pack A · 自制演示稿', 'demo_illustration', 'packA'),
    media('pack-b-kit', packPresets.B.referenceAssets[0], 'Pack B · 自制演示稿', 'demo_illustration', 'packB'),
    media('pack-a-structure', packPresets.A.referenceAssets[1], 'Pack A · 自制盒型示意', 'demo_illustration'),
    media('pack-b-structure', packPresets.B.referenceAssets[1], 'Pack B · 自制盒型示意', 'demo_illustration'),
    media('lifestyle-kit', '03-packaging/lifestyle-approved-visual.png', '酒店早餐 · 自制演示稿', 'demo_illustration', 'lifestyle'),
  ],
};

import { describeImage } from './proposal-pdf-images.mjs';

const width = 842;
const height = 595;
const margin = 38;
const innerWidth = width - 2 * margin;
const palette = {
  ivory: '#f9f7f0', ink: '#24392f', body: '#38443c', muted: '#4e5e51',
  olive: '#4e633c', line: '#deded2', shade: '#eef0e3', well: '#eeebe3', white: '#ffffff',
};
const fontNames = { serif: 'Times-Roman', sans: 'Helvetica', bold: 'Helvetica-Bold' };
const reference = (id) => `${id} 0 R`;

function english(value) {
  return String(value ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function literal(value) {
  return `(${english(value).replace(/[\\()]/g, '\\$&')})`;
}

function color(hex) {
  return hex.slice(1).match(/../g).map((channel) => (parseInt(channel, 16) / 255).toFixed(3)).join(' ');
}

function pdfDocument() {
  const objects = [null];
  const add = (body = null) => objects.push(typeof body === 'string' ? Buffer.from(body, 'ascii') : body) - 1;
  const stream = (dictionary, bytes) => add(Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`, 'ascii'),
    bytes,
    Buffer.from('\nendstream', 'ascii'),
  ]));
  const pages = add();
  const catalog = add(`<< /Type /Catalog /Pages ${reference(pages)} >>`);
  const fonts = Object.fromEntries(Object.entries(fontNames).map(([key, value]) => [key,
    add(`<< /Type /Font /Subtype /Type1 /BaseFont /${value} /Encoding /WinAnsiEncoding >>`),
  ]));
  const pageIds = [];

  function addPage(commands, images, links) {
    const contents = stream('', Buffer.from(commands.join('\n'), 'ascii'));
    const fontMap = Object.entries(fonts).map(([name, id]) => `/${name} ${reference(id)}`).join(' ');
    const imageMap = images.map((id, index) => `/I${index} ${reference(id)}`).join(' ');
    const annotations = links.map(({ url, x, y, w, h }) => add(
      `<< /Type /Annot /Subtype /Link /Rect [${x} ${height - y - h} ${x + w} ${height - y}] /Border [0 0 0] /A << /S /URI /URI ${literal(url)} >> >>`,
    )).map(reference).join(' ');
    pageIds.push(add(`<< /Type /Page /Parent ${reference(pages)} /MediaBox [0 0 ${width} ${height}]
/Resources << /Font << ${fontMap} >> /XObject << ${imageMap} >> >> /Annots [${annotations}] /Contents ${reference(contents)} >>`));
  }

  function addImage(image) {
    const alpha = image.alpha ? ` /SMask ${reference(addImage(image.alpha))}` : '';
    return stream(`/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ${image.dictionary}${alpha}`, image.bytes);
  }

  function bytes(title) {
    objects[pages] = Buffer.from(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(reference).join(' ')}] >>`, 'ascii');
    const info = add(`<< /Title ${literal(title)} /Creator (Porvia) >>`);
    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const xref = ['0000000000 65535 f \n'];
    for (const [index, body] of objects.entries()) {
      if (index === 0) continue;
      const start = Buffer.from(`${index} 0 obj\n`, 'ascii');
      const end = Buffer.from('\nendobj\n', 'ascii');
      xref.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
      chunks.push(start, body, end);
      offset += start.length + body.length + end.length;
    }
    chunks.push(Buffer.from(`xref\n0 ${objects.length}\n${xref.join('')}trailer\n<< /Size ${objects.length} /Root ${reference(catalog)} /Info ${reference(info)} >>\nstartxref\n${offset}\n%%EOF\n`, 'ascii'));
    return Buffer.concat(chunks);
  }

  return { addImage, addPage, bytes };
}

function textWidth(text, size, tracking = 0) {
  let units = 0;
  for (const char of text) {
    if (" .,:;'!ijlI|".includes(char)) units += 0.29;
    else if ('MWmw@%'.includes(char)) units += 0.85;
    else if (/[A-Z]/.test(char)) units += 0.68;
    else units += 0.53;
  }
  return units * size + Math.max(0, text.length - 1) * tracking;
}

function pageCanvas(document) {
  const commands = [];
  const images = [];
  const links = [];
  const rectangle = (x, y, w, h, fill) => {
    commands.push(`${color(fill)} rg ${x} ${height - y - h} ${w} ${h} re f`);
  };
  const rule = (x, y, w, stroke = palette.line) => {
    commands.push(`${color(stroke)} RG 0.65 w ${x} ${height - y} m ${x + w} ${height - y} l S`);
  };
  const line = (value, x, y, { size = 11, font = 'sans', fill = palette.body, tracking = 0, max = innerWidth, right = false } = {}) => {
    let display = english(value);
    if (!display) return;
    while (display.length > 3 && textWidth(display, size, tracking) > max) display = `${display.slice(0, display.endsWith('...') ? -4 : -1)}...`;
    const left = right ? Math.round(x - textWidth(display, size, tracking)) : x;
    commands.push(`BT ${color(fill)} rg /${font} ${size} Tf ${tracking} Tc 1 0 0 1 ${left} ${height - y} Tm ${literal(display)} Tj ET`);
  };
  const kicker = (value, x, y, opts = {}) => line(String(value).toUpperCase(), x, y, {
    size: 8, font: 'bold', fill: palette.olive, tracking: 1.18, ...opts,
  });
  const art = (image, x, y, w, h, { fill = palette.well, fit = 'contain' } = {}) => {
    rectangle(x, y, w, h, fill);
    if (!image) {
      line('No image selected', x + Math.round(w / 2) - 45, y + Math.round(h / 2), { size: 10, fill: palette.muted });
      return;
    }
    const scale = (fit === 'cover' ? Math.max : Math.min)(w / image.width, h / image.height);
    const iw = Math.round(image.width * scale);
    const ih = Math.round(image.height * scale);
    const ox = x + Math.round((w - iw) / 2);
    const oy = height - y - h + Math.round((h - ih) / 2);
    const name = `I${images.length}`;
    images.push(image.id);
    commands.push(`q ${x} ${height - y - h} ${w} ${h} re W n ${iw} 0 0 ${ih} ${ox} ${oy} cm /${name} Do Q`);
  };
  const link = (url, label, x, y) => {
    line(label, x, y, { size: 10, font: 'bold', fill: palette.olive });
    const w = Math.round(textWidth(label, 10));
    rule(x, y + 2, w, palette.olive);
    links.push({ url, x, y: y - 11, w: w + 2, h: 14 });
  };
  const band = (title, detail, y = 482) => {
    rectangle(margin, y, innerWidth, 53, palette.shade);
    kicker(title, margin + 13, y + 17);
    line(detail, margin + 13, y + 35, { font: 'sans', size: 11, max: innerWidth - 26 });
  };
  const finish = () => document.addPage(commands, images, links);
  return { rectangle, rule, line, kicker, art, link, band, finish };
}

function startPage(document, snapshot, number, section, title, intro, footer) {
  const page = pageCanvas(document);
  page.rectangle(0, 0, width, height, palette.ivory);
  page.kicker(`${snapshot.collection} / BONE CHINA`, margin, 31, { max: 380 });
  page.kicker(`BUYER PROPOSAL / ${snapshot.id} / V${snapshot.version}`, width - margin, 31, { right: true, max: 330 });
  page.rule(margin, 43, innerWidth);
  page.kicker(section, margin, 67);
  page.line(title, margin, 110, { font: 'serif', size: 38, fill: palette.ink });
  page.line(intro, margin, 135, { size: 12 });
  page.rule(margin, 553, innerWidth);
  page.line(footer, margin, 573, { size: 8.5, fill: palette.muted, max: innerWidth - 60 });
  page.kicker(`${String(number).padStart(2, '0')} / 04`, width - margin, 573, { right: true });
  return page;
}

const assetStatus = {
  demo_illustration: 'Demo illustration',
  supplier_photo: 'Supplier product photograph',
  ai_preview: 'AI-generated concept',
  model_preview: 'AI-generated concept',
  local_overlay: 'Digital artwork placement preview',
  local_copy: 'Local packaging concept preview',
  local_adjustment: 'AI concept with a local color adjustment',
  uploaded_preview: 'User-provided concept image',
};

function status(asset) {
  return asset ? assetStatus[asset.kind] ?? 'Selected concept image' : 'Image pending selection';
}

function draftQuantity(buyer) {
  if (!Number.isSafeInteger(buyer?.quantity) || buyer.quantity < 1) return null;
  const raw = String(buyer.quantityQualifier ?? '');
  const qualifier = /approx|around|about|rough|[约大概~]/i.test(raw) ? 'Approximately ' : '';
  const firstOrder = /initial|first|首批/i.test(raw) ? ' for the initial order' : '';
  return `${qualifier}${buyer.quantity.toLocaleString('en-US')} sets${firstOrder}`;
}

const packagingLabels = new Map([
  ['pack-a', 'Pack A (printed folding carton)'], ['包装a', 'Pack A (printed folding carton)'],
  ['pack-b', 'Pack B (rigid gift box)'], ['包装b', 'Pack B (rigid gift box)'],
  ['folding carton', 'a folding carton'], ['折叠彩盒', 'a folding carton'],
  ['rigid gift box', 'a rigid gift box'], ['硬质礼盒', 'a rigid gift box'],
  ['gift box', 'a gift box'], ['礼盒', 'a gift box'],
]);

const customPackagingLabels = new Map([
  ...packagingLabels,
  ['pack-a', 'Pack A'], ['包装a', 'Pack A'], ['pack-b', 'Pack B'], ['包装b', 'Pack B'],
]);

function confirmedPackaging(buyer, labels = packagingLabels) {
  if (buyer?.packagingConfirmed !== true || !Array.isArray(buyer.packaging) || buyer.packaging.length !== 1) return null;
  const choice = typeof buyer.packaging[0] === 'string' ? buyer.packaging[0].trim() : '';
  if (!choice) return null;
  const key = choice.toLowerCase().replace(/^包装\s*([ab])$/, '包装$1');
  return { label: labels.get(key) ?? (/^[\x20-\x7e]+$/.test(choice) ? choice : null) };
}

function supplierURL(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const imageSlots = ['lifestyle', 'source', 'printA', 'printB', 'packA', 'packB'];

function customProposal(document, snapshot, pictures) {
  const { product, buyer, selections } = snapshot;
  const collection = english(snapshot.collection) || 'Custom project';
  const pageSnapshot = { ...snapshot, collection, id: snapshot.id.slice(0, 8) };
  const name = english(product.nameEn) || english(product.nameZh);
  const sku = english(product.sku);
  const quantity = draftQuantity(buyer);
  const packaging = confirmedPackaging(buyer, customPackagingLabels);
  const footer = 'Porvia buyer proposal';

  const cover = startPage(document, pageSnapshot, 1, 'Project overview', name || 'Bone china buyer proposal',
    `Project / ${collection}`, footer);
  cover.art(pictures.lifestyle ?? pictures.source, margin, 155, innerWidth, 344,
    { fit: pictures.lifestyle ? 'cover' : 'contain' });
  cover.kicker(pictures.lifestyle ? status(selections.lifestyle) : 'Product reference image', margin, 518);
  if (sku) cover.line(`SKU / ${sku}`, margin, 535, { max: 460, size: 9.5 });
  const use = english(buyer?.use);
  const useSummary = buyer?.use ? 'Intended use recorded in inquiry' : 'Intended use to be confirmed';
  cover.line(use ? `Intended use / ${use}` : useSummary, width - margin, 518,
    { max: 280, right: true, size: 9.5 });
  cover.line(quantity ? `Planned order / ${quantity}` : 'Order quantity to be confirmed', width - margin, 535,
    { max: 280, right: true, font: 'bold', size: 9.5 });
  cover.finish();

  const details = startPage(document, pageSnapshot, 2, 'Product specification', 'Product details',
    'Product information for buyer review.', footer);
  details.art(pictures.source, margin, 155, 409, 286, { fill: palette.white });
  details.kicker('Product reference image', margin, 461);
  const dataX = 474;
  details.kicker('Product information', dataX, 174);
  const specification = ({ value, unit }) => english([value, unit === 'ml' ? 'mL' : unit].filter(item => item != null).join(' '));
  const productName = name || (product.nameZh ? 'English name pending' : '');
  const data = [
    ['Product name', productName],
    ['SKU', sku],
    ['Supplier', english(product.supplier)],
    ['Material', product.material?.value == null ? '' : specification(product.material)],
    ['Capacity', product.capacity?.value == null ? '' : specification(product.capacity)],
    ...[
      ['Cup height', product.cupHeight],
      ['Cup diameter', product.cupDiameter],
      ['Saucer dimension', product.saucerPublishedDimension],
    ].filter(([, spec]) => spec?.value != null).map(([label, spec]) => [label, specification(spec)]),
  ];
  data.forEach(([label, value], index) => {
    const y = 205 + 30 * index;
    details.line(label, dataX, y, { font: 'bold', size: 10, max: 135 });
    details.line(value || 'Pending', dataX + 139, y, { size: 11, max: 190 });
    details.rule(dataX, y + 9, width - margin - dataX);
  });
  details.band('Buyer review', 'Confirm the product details before placing an order.');
  details.finish();

  const print = startPage(document, pageSnapshot, 3, 'Artwork options', 'Print options',
    'Review the available artwork placement previews.', footer);
  const gap = 16;
  const column = (innerWidth - gap) / 2;
  for (const [index, letter] of ['A', 'B'].entries()) {
    const slot = `print${letter}`;
    const x = margin + index * (column + gap);
    print.art(pictures[slot], x, 155, column, 255);
    print.line(`Print ${letter}`, x, 440, { font: 'serif', size: 23, fill: palette.ink });
    if (selections[slot]) print.line(status(selections[slot]), x, 461, { size: 10, max: column });
  }
  print.band('Sample approval', 'Confirm final artwork size and placement on the sample.');
  print.finish();

  let packagingIntro = 'Review the available packaging concepts.';
  if (packaging) {
    packagingIntro = packaging.label ? `The buyer confirmed ${packaging.label}.` : 'The buyer has confirmed a packaging choice.';
  }
  const pack = startPage(document, pageSnapshot, 4, 'Packaging options',
    packaging ? 'Packaging choice confirmed' : 'Packaging options', packagingIntro, footer);
  for (const [index, letter] of ['A', 'B'].entries()) {
    const slot = `pack${letter}`;
    const x = margin + index * (column + gap);
    pack.art(pictures[slot], x, 155, column, 255);
    pack.line(`Pack ${letter}`, x, 440, { font: 'serif', size: 23, fill: palette.ink });
    if (selections[slot]) pack.line(status(selections[slot]), x, 461, { size: 10, max: column });
  }
  pack.band('Factory confirmation', 'Confirm final packaging dimensions, materials and fit before production.');
  pack.finish();

  return document.bytes(`${collection} - Buyer proposal V${snapshot.version}`);
}

export async function createProposalPdf(snapshot, loadAsset) {
  const document = pdfDocument();
  const { product, buyer, selections, packPresets } = snapshot;
  if (!product || !selections?.source) throw new Error('Select a supplier product photograph before exporting.');
  const pictures = {};
  const embedded = new Map();
  for (const slot of imageSlots) {
    const asset = selections[slot];
    if (!asset) continue;
    if (!embedded.has(asset.id)) {
      try {
        const image = describeImage(await loadAsset(asset));
        embedded.set(asset.id, { id: document.addImage(image), width: image.width, height: image.height });
      } catch (error) {
        throw new Error(`Cannot export ${asset.label || slot}: ${error.code === 'ENOENT' ? 'the selected image file is missing.' : error.message}`, { cause: error });
      }
    }
    pictures[slot] = embedded.get(asset.id);
  }
  if (snapshot.projectMode === 'blank') return customProposal(document, snapshot, pictures);

  const sku = english(product.sku);
  const supplier = english(product.supplier) || 'Supplier';
  const packaging = confirmedPackaging(buyer);
  const hotelUse = /hotel.*breakfast|酒店.{0,8}早餐/i.test(buyer?.use ?? '');
  const quantity = draftQuantity(buyer);
  const quantityNote = quantity ? `Planned order / ${quantity}` : buyer?.quantity === null ? 'Order quantity to be confirmed' : null;
  const cover = startPage(document, snapshot, 1, 'Lifestyle preview', hotelUse ? 'Bone china for hotel breakfast' : 'Bone china buyer proposal',
    hotelUse ? 'A painterly lemon and blue flower motif for a hotel breakfast service.' : 'A painterly lemon and blue flower motif on a fine bone china cup and saucer.',
    'Porvia demonstration proposal');
  cover.art(pictures.lifestyle, margin, 155, innerWidth, 344, { fit: 'cover' });
  cover.kicker(status(selections.lifestyle), margin, 518);
  cover.line(`Featuring ${supplier} ${sku} cup & square saucer. Artwork and setting are illustrative.`, margin, 535, { max: 500, size: 9.5 });
  if (buyer?.use === null) cover.line('Intended use to be confirmed', width - margin, 518, { max: 242, right: true, size: 9.5 });
  if (quantityNote) cover.line(quantityNote, width - margin, 535, { max: 242, right: true, font: 'bold', size: 9.5 });
  cover.finish();

  const specs = startPage(document, snapshot, 2, 'Product specification', 'Cup & square saucer',
    `${supplier} model ${sku} is the base shape for both print and packaging options.`, `Product photograph and published specifications from ${supplier}`);
  specs.art(pictures.source, margin, 155, 409, 286, { fill: palette.white });
  specs.kicker(status(selections.source), margin, 461);
  const dataX = 474;
  specs.kicker(`Model ${sku} / Supplier published`, dataX, 174);
  const format = ({ value, unit } = {}) => value == null ? 'Pending' : [value, unit === 'ml' ? 'mL' : unit].filter(Boolean).join(' ');
  const cupCount = product.setContents?.find(({ name }) => name === 'cup')?.quantity ?? 1;
  const saucerCount = product.setContents?.find(({ name }) => name === 'saucer')?.quantity ?? 1;
  const data = [
    ['Material', format(product.material)],
    ['Cup capacity', format(product.capacity)],
    ['Cup height', format(product.cupHeight)],
    ['Cup diameter', format(product.cupDiameter)],
    ['Saucer dimension*', format(product.saucerPublishedDimension)],
    ['Set contents', `${cupCount} cup and ${saucerCount} square saucer`],
  ];
  data.forEach(([label, value], i) => {
    const y = 205 + 30 * i;
    specs.line(label, dataX, y, { font: 'bold', size: 10, max: 135 });
    specs.line(value, dataX + 139, y, { size: 11, max: 190 });
    specs.rule(dataX, y + 9, width - margin - dataX);
  });
  specs.line('* Listed by the supplier as "Saucer Diameter".', dataX, 382, { size: 9 });
  specs.line('Exact square saucer dimensions await factory confirmation.', dataX, 396, { size: 9, max: 324 });
  const url = supplierURL(product.sourceUrl);
  if (url) specs.link(url, `View ${supplier} product and specifications`, dataX, 430);
  specs.band('Buyer review', packaging
    ? `Confirm model ${sku}, then choose your preferred print option.`
    : `Confirm model ${sku}, then choose your preferred print and packaging options.`);
  specs.finish();

  const print = startPage(document, snapshot, 3, 'Artwork options', 'Compare two print sizes',
    `The lemon and blue flower motif, placed on the front of the model ${sku} cup.`, `Base cup shape from ${supplier} model ${sku} / Artwork placement concepts`);
  const gap = 16;
  const column = (innerWidth - gap) / 2;
  for (const [i, key] of ['printA', 'printB'].entries()) {
    const x = margin + i * (column + gap);
    print.art(pictures[key], x, 155, column, 242);
    print.kicker(i === 0 ? 'Print A' : 'Print B', x, 419);
    print.line(i === 0 ? 'Small print' : 'Large print', x, 444, { font: 'serif', size: 23, fill: palette.ink });
    print.line(status(selections[key]), x, 462, { size: 10, max: column });
  }
  print.band('Buyer selection', 'Choose Print A or Print B. Final print dimensions and placement are subject to sample approval.');
  print.finish();

  let packagingIntro = `Two packaging concepts for one model ${sku} cup and one square saucer.`;
  if (packaging) {
    packagingIntro = packaging.label ? `The buyer confirmed ${packaging.label} for model ${sku}.` : `The buyer's packaging choice for model ${sku} has been recorded.`;
  }
  const pack = startPage(document, snapshot, 4, packaging ? 'Packaging concepts' : 'Packaging options',
    packaging ? 'Packaging choice confirmed' : 'Choose a packaging direction',
    packagingIntro, `Packaging concept previews / Cup and saucer based on ${supplier} model ${sku}`);
  for (const [i, [key, letter]] of [['packA', 'A'], ['packB', 'B']].entries()) {
    const x = margin + i * (column + gap);
    pack.art(pictures[key], x, 155, column, 204);
    pack.kicker(`Pack ${letter}`, x, 381);
    pack.line(packPresets?.[letter]?.nameEn || (i === 0 ? 'Printed Folding Carton' : 'Rigid Gift Box'), x, 406, { font: 'serif', size: 23, fill: palette.ink, max: column });
    pack.line(status(selections[key]), x, 425, { size: 10, max: column });
    const details = i === 0 ? 'Paperboard compartments and subtle lemon linework.' : 'Lift-off lid, fitted insert and a small gold-foil lemon sprig.';
    pack.line(details, x, 443, { size: 9.5, max: column });
  }
  pack.line('Final dimensions, materials and insert fit are subject to factory confirmation.', margin, 468, { size: 9.5 });
  pack.band('Request a quote and sample', packaging
    ? `Reply with model ${sku}, Print A or B, and your estimated order quantity.`
    : `Reply with model ${sku}, Print A or B, Pack A or B, and your estimated order quantity.`);
  pack.finish();

  return document.bytes(`${snapshot.collection} - Buyer proposal V${snapshot.version}`);
}

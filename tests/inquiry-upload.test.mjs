import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import { readInquiryUpload } from '../src/inquiry-upload.mjs';

const upload = (filename, bytes) => readInquiryUpload({ filename, content: Buffer.from(bytes).toString('base64') });

function docx(body, prolog = '') {
  const document = `${prolog}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:body>${body}</w:body>
  </w:document>`;
  return zipSync({ 'word/document.xml': Buffer.from(document) }, { level: 6 });
}

const pdfStream = contents => `<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`;

function singlePagePdf(contents, resources = '<< >>', extraObjects = []) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources ${resources} /Contents 4 0 R >>`,
    pdfStream(contents),
    ...extraObjects,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((body, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  const xref = pdf.length;
  const size = objects.length + 1;
  pdf += `xref\n0 ${size}\n0000000000 65535 f \n${offsets.join('')}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

test('reads UTF-8 and UTF-16 BOM text, including Markdown and Chinese', async () => {
  const plain = '酒店早餐用，约 350 套。\nPlease show a gift box.';
  const windows = plain.replaceAll('\n', '\r\n');
  assert.equal(await upload('订单.TXT', Buffer.from(`\uFEFF${windows}`)), plain);
  assert.equal(await upload('订单.txt', Buffer.from(`\uFEFF${windows}`, 'utf16le')), plain);
  assert.equal(await upload('订单.txt', Buffer.from(`\uFEFF${windows}`, 'utf16le').swap16()), plain);
  assert.equal(await upload('follow-up.md', '# Revised\n300 sets'), '# Revised\n300 sets');
});

test('reads text runs, paragraphs, entities, tab and line break in Word', async () => {
  const bytes = docx(`<w:p><w:r><w:t>酒店 &amp; 餐厅</w:t></w:r><w:r><w:tab/><w:t>Model 146</w:t></w:r></w:p>
    <w:p><w:r><w:t>300 sets</w:t><w:br/><w:t><![CDATA[Gift box <green>]]></w:t></w:r></w:p>`);
  assert.equal(await upload('询盘.DOCX', bytes), '酒店 & 餐厅\tModel 146\n300 sets\nGift box <green>');
});

test('reads text-layer PDF and rejects image-only pages clearly', async () => {
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const proposal = singlePagePdf(
    'BT /F1 5 Tf 5 80 Td (Bone china for hotel breakfast) Tj 0 -10 Td (Choose a packaging direction) Tj ET',
    '<< /Font << /F1 5 0 R >> >>', [font],
  );
  const body = await upload('proposal.pdf', proposal);
  assert.match(body, /Bone china for hotel breakfast/);
  assert.match(body, /choose a packaging direction/i);
  const imageOnly = singlePagePdf('q 1 0 0 1 0 0 cm\nBI /W 1 /H 1 /BPC 8 /CS /G ID\n\x80\nEI\nQ');
  await assert.rejects(upload('scan.pdf', imageOnly), { status: 422, message: /没有可提取的文字/ });
});

test('normalizes compatibility characters in Chinese PDF text while preserving unrelated characters', async () => {
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>';
  const cmap = pdfStream(`begincmap
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<00> <FF>
endcodespacerange
4 beginbfchar
<41> <2F64>
<42> <FF21>
<43> <FA19>
<44> <D87EDC00>
endbfchar
endcmap`);
  const pdf = singlePagePdf('BT /F1 10 Tf 10 80 Td (ABCD) Tj ET', '<< /Font << /F1 5 0 R >> >>', [font, cmap]);
  assert.equal(await upload('中文询盘.pdf', pdf), '用Ａ神丽');
});

test('rejects invalid format, size, encoding and excessive extracted text', async () => {
  await assert.rejects(upload('订单.html', '<p>Hello</p>'), { status: 422, message: /请选择/ });
  await assert.rejects(upload('订单.txt', ''), { status: 422, message: /为空/ });
  await assert.rejects(upload('订单.md', '\r\n\t'), { status: 422, message: /没有可读取/ });
  await assert.rejects(upload('订单.txt', Buffer.from([0x50, 0x4b, 0x01, 0x02])), { status: 422, message: /编码/ });
  await assert.rejects(upload('订单.txt', 'a'.repeat(16_001)), { status: 422, message: /16,000/ });
  await assert.rejects(upload('big.txt', Buffer.alloc(8 * 1024 * 1024 + 1)), { status: 413, message: /8 MB/ });
  await assert.rejects(upload('订单.docx', '1 set'), { status: 422, message: /Word/ });
  await assert.rejects(upload('订单.docx', docx('<w:p><w:r><w:t>&external;</w:t></w:r></w:p>',
    '<!DOCTYPE document [<!ENTITY external SYSTEM "file:///etc/hosts">]>')),
  { status: 422, message: /Word/ });
  await assert.rejects(upload('订单.pdf', 'Not a PDF'), { status: 422, message: /PDF 格式不符/ });
  await assert.rejects(readInquiryUpload({ filename: '订单.txt', content: '#%+=' }), { status: 422, message: /重新选择/ });
});

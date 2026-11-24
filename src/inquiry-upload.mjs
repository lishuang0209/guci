import { extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { SaxesParser } from 'saxes';
import { WorkspaceError } from './store.mjs';

const maxFileBytes = 8 * 1024 * 1024;
const maxCharacters = 16_000;
const maxWordXmlBytes = 2 * 1024 * 1024;
const maxPdfPages = 100;
const textExtensions = new Set(['.txt', '.md']);
const pdfCjkCompatibilityForms = /[\u2e80-\u2fdf\uf900-\ufaff\u{2f800}-\u{2fa1f}]/gu;
const wordNamespaces = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);

function checkLength(length) {
  if (length > maxCharacters) throw new WorkspaceError(422, '文件正文超过 16,000 字符。请拆分文件，或粘贴相关段落。');
}

function decodeText(bytes) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' :
    bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new Error('Binary content');
    return text;
  } catch {
    throw new WorkspaceError(422, '无法读取文件文字。文本文件请使用 UTF-8 或带 BOM 的 UTF-16 编码。');
  }
}

function readDocx(bytes) {
  try {
    if (bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('Missing ZIP header');
    let found = false;
    const { 'word/document.xml': document } = unzipSync(bytes, { filter(entry) {
      if (entry.name !== 'word/document.xml') return false;
      if (found || entry.originalSize > maxWordXmlBytes || entry.size > maxWordXmlBytes) {
        throw new Error('Invalid document part');
      }
      found = true;
      return true;
    } });
    if (!document || document.length > maxWordXmlBytes) throw new Error('Missing document part');

    const parser = new SaxesParser({ xmlns: true });
    const lines = [];
    let length = 0;
    let inBody = false;
    let inText = false;
    let seenRoot = false;
    const append = text => {
      length += text.length;
      checkLength(length);
      lines.push(text);
    };
    parser.on('doctype', () => { throw new Error('Unexpected doctype'); });
    parser.on('opentag', node => {
      if (!seenRoot) {
        seenRoot = true;
        if (node.local !== 'document' || !wordNamespaces.has(node.uri)) throw new Error('Invalid Word document root');
      }
      if (!wordNamespaces.has(node.uri)) return;
      if (node.local === 'body') inBody = true;
      if (!inBody) return;
      if (node.local === 't') inText = true;
      if (node.local === 'tab') append('\t');
      if (node.local === 'br' || node.local === 'cr') append('\n');
    });
    parser.on('closetag', node => {
      if (!inBody || !wordNamespaces.has(node.uri)) return;
      if (node.local === 'body') inBody = false;
      if (node.local === 't') inText = false;
      if (node.local === 'p') append('\n');
    });
    const appendText = text => { if (inText) append(text); };
    parser.on('text', appendText);
    parser.on('cdata', appendText);
    parser.write(decodeText(document)).close();
    return lines.join('');
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new WorkspaceError(422, '无法读取 Word 文档。请上传可打开的 .docx 文件。');
  }
}

async function readPdf(bytes) {
  if (!bytes.subarray(0, 1024).includes('%PDF-')) throw new WorkspaceError(422, '文件内容与 PDF 格式不符。');

  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const packageUrl = import.meta.resolve('pdfjs-dist/package.json');
  const resourcePath = directory => fileURLToPath(new URL(directory, packageUrl)) + sep;
  const task = getDocument({
    data: Uint8Array.from(bytes), cMapUrl: resourcePath('./cmaps'), cMapPacked: true,
    standardFontDataUrl: resourcePath('./standard_fonts'), useWorkerFetch: false,
    useWasm: false, useSystemFonts: false, disableFontFace: true, stopAtErrors: true,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > maxPdfPages) throw new WorkspaceError(422, 'PDF 超过 100 页。请上传相关页面或粘贴原文。');
    const pages = [];
    let length = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const { items } = await page.getTextContent();
      const text = items.map(item => item.str + (item.hasEOL ? '\n' : '')).join('').trim()
        .replace(pdfCjkCompatibilityForms, character => character.normalize('NFKC'));
      if (text) {
        length += text.length + (pages.length ? 2 : 0);
        checkLength(length);
        pages.push(text);
      }
      page.cleanup();
    }
    if (!pages.length) throw new WorkspaceError(422, 'PDF 中没有可提取的文字。请上传带文字层的 PDF，或粘贴原文。');
    return pages.join('\n\n');
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if (error?.name === 'PasswordException') throw new WorkspaceError(422, 'PDF 受密码保护。请上传已解锁的副本。');
    throw new WorkspaceError(422, '无法读取 PDF。请确认文件完整且可以打开。');
  } finally {
    await task.destroy();
  }
}

export async function readInquiryUpload({ filename, content }) {
  const extension = typeof filename === 'string' ? extname(filename).toLowerCase() : '';
  if (!textExtensions.has(extension) && extension !== '.docx' && extension !== '.pdf') {
    throw new WorkspaceError(422, '请选择 TXT、Markdown、Word（DOCX）或带文字层的 PDF 文件。');
  }
  if (typeof content !== 'string' || !content) throw new WorkspaceError(422, '文件为空。');
  if (content.length > Math.ceil(maxFileBytes / 3) * 4) throw new WorkspaceError(413, '文件超过 8 MB。');
  if (content.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(content)) {
    throw new WorkspaceError(422, '无法读取上传文件。请重新选择文件。');
  }
  const bytes = Buffer.from(content, 'base64');
  if (bytes.length > maxFileBytes) throw new WorkspaceError(413, '文件超过 8 MB。');

  const text = textExtensions.has(extension) ? decodeText(bytes) : extension === '.docx' ? readDocx(bytes) : await readPdf(bytes);
  const normalized = text.replace(/\r\n?/gu, '\n').trim();
  if (!normalized) throw new WorkspaceError(422, '文件中没有可读取的正文。');
  checkLength(normalized.length);
  return normalized;
}

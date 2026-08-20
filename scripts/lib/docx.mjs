import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DOCUMENT_PART = 'word/document.xml';

const SIG_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const SIG_CENTRAL_FILE_HEADER = 0x02014b50;
const SIG_LOCAL_FILE_HEADER = 0x04034b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_ZIP_COMMENT_SIZE = 0xffff;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const XML_NAMED_ENTITIES = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXmlEntities(value) {
  return value
    .replace(/&(lt|gt|quot|apos);/g, (_match, name) => XML_NAMED_ENTITIES[name])
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

function findEndOfCentralDirectory(buffer) {
  const floor = Math.max(0, buffer.length - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_ZIP_COMMENT_SIZE);
  for (let offset = buffer.length - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === SIG_END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('Not a ZIP container: end of central directory record not found.');
}

function readCentralDirectory(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL_FILE_HEADER) {
      throw new Error(`Corrupt ZIP: central file header expected at byte ${offset}.`);
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    entries.push({
      name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export function readZipEntry(buffer, entryName) {
  const entry = readCentralDirectory(buffer).find((candidate) => candidate.name === entryName);
  if (!entry) throw new Error(`ZIP entry not found: ${entryName}`);

  const localOffset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL_FILE_HEADER) {
    throw new Error(`Corrupt ZIP: local file header expected at byte ${localOffset}.`);
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === METHOD_STORE) return Buffer.from(data);
  if (entry.method === METHOD_DEFLATE) return inflateRawSync(data);
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entryName}.`);
}

function readEntryViaPowerShell(docxPath, entryName) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogp-docx-'));
  try {
    const zipPath = path.join(workDir, 'container.zip');
    const outDir = path.join(workDir, 'expanded');
    fs.copyFileSync(docxPath, zipPath);
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force`,
      ],
      { stdio: 'pipe' },
    );
    return fs.readFileSync(path.join(outDir, ...entryName.split('/')));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export function extractDocumentXml(docxPath, options = {}) {
  const part = options.part ?? DOCUMENT_PART;
  const container = fs.readFileSync(docxPath);
  try {
    return {
      xml: readZipEntry(container, part).toString('utf8'),
      method: 'zlib',
      sourceBytes: container.length,
    };
  } catch (zlibError) {
    try {
      return {
        xml: readEntryViaPowerShell(docxPath, part).toString('utf8'),
        method: 'powershell',
        sourceBytes: container.length,
      };
    } catch (shellError) {
      throw new Error(
        `Unable to extract ${part} from ${docxPath}. ` +
          `Inflate failed: ${zlibError.message}. Expand-Archive failed: ${shellError.message}.`,
      );
    }
  }
}

const PARAGRAPH_PATTERN = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
const PARAGRAPH_PROPERTIES_PATTERN = /<w:pPr\b[^>]*\/>|<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/;
const PARAGRAPH_STYLE_PATTERN = /<w:pStyle\s+w:val="([^"]+)"\s*\/?>/;
const HEADING_STYLE_PATTERN = /^Heading([1-9])$/;
const RUN_PATTERN = /<w:r\b[^>]*\/>|<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
const RUN_PROPERTIES_PATTERN = /<w:rPr\b[^>]*\/>|<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/;
const BOLD_PATTERN = /<w:b(?:\s+w:val="(?:1|true|on)")?\s*\/?>/;
const ITALIC_PATTERN = /<w:i(?:\s+w:val="(?:1|true|on)")?\s*\/?>/;
const RUN_CONTENT_PATTERN =
  /<w:t\b[^>]*\/>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/?>|<w:tab\b[^>]*\/?>/g;
const LOOSE_BREAK_PATTERN = /<w:br\b[^>]*\/?>/g;
const PAGE_OR_COLUMN_BREAK_PATTERN = /w:type="(?:page|column)"/;

function pushRun(line, text, bold, italic) {
  if (text === '') return;
  const previous = line.runs[line.runs.length - 1];
  if (previous && previous.bold === bold && previous.italic === italic) {
    previous.text += text;
    return;
  }
  line.runs.push({ text, bold, italic });
}

function trimLineEdges(line) {
  if (line.runs.length > 0) {
    line.runs[0].text = line.runs[0].text.replace(/^\s+/, '');
    line.runs[line.runs.length - 1].text = line.runs[line.runs.length - 1].text.replace(/\s+$/, '');
  }
  line.runs = line.runs.filter((run) => run.text !== '');
  return line;
}

function parseParagraph(paragraphXml, index) {
  const propertiesMatch = paragraphXml.match(PARAGRAPH_PROPERTIES_PATTERN);
  const properties = propertiesMatch ? propertiesMatch[0] : '';
  const styleMatch = properties.match(PARAGRAPH_STYLE_PATTERN);
  const styleId = styleMatch ? styleMatch[1] : '';
  const headingMatch = styleId.match(HEADING_STYLE_PATTERN);
  const level = headingMatch ? Number.parseInt(headingMatch[1], 10) : 0;

  const content = propertiesMatch
    ? paragraphXml.replace(propertiesMatch[0], '')
    : paragraphXml;

  const lines = [{ runs: [] }];

  const consumeRun = (runXml) => {
    const runProperties = runXml.match(RUN_PROPERTIES_PATTERN);
    const bold = runProperties ? BOLD_PATTERN.test(runProperties[0]) : false;
    const italic = runProperties ? ITALIC_PATTERN.test(runProperties[0]) : false;
    const body = runProperties ? runXml.replace(runProperties[0], '') : runXml;

    RUN_CONTENT_PATTERN.lastIndex = 0;
    let token;
    while ((token = RUN_CONTENT_PATTERN.exec(body)) !== null) {
      const raw = token[0];
      if (raw.startsWith('<w:br')) {
        if (!PAGE_OR_COLUMN_BREAK_PATTERN.test(raw)) lines.push({ runs: [] });
        continue;
      }
      if (raw.startsWith('<w:tab')) {
        pushRun(lines[lines.length - 1], '\t', bold, italic);
        continue;
      }
      if (token[1] !== undefined) {
        pushRun(lines[lines.length - 1], decodeXmlEntities(token[1]), bold, italic);
      }
    }
  };

  const consumeGap = (gapXml) => {
    LOOSE_BREAK_PATTERN.lastIndex = 0;
    let token;
    while ((token = LOOSE_BREAK_PATTERN.exec(gapXml)) !== null) {
      if (!PAGE_OR_COLUMN_BREAK_PATTERN.test(token[0])) lines.push({ runs: [] });
    }
  };

  RUN_PATTERN.lastIndex = 0;
  let cursor = 0;
  let run;
  while ((run = RUN_PATTERN.exec(content)) !== null) {
    consumeGap(content.slice(cursor, run.index));
    consumeRun(run[0]);
    cursor = RUN_PATTERN.lastIndex;
  }
  consumeGap(content.slice(cursor));

  const normalized = lines.map(trimLineEdges).filter((line, position, all) => {
    if (line.runs.length > 0) return true;
    return position > 0 && position < all.length - 1;
  });
  const finalLines = normalized.length > 0 ? normalized : [{ runs: [] }];
  const text = finalLines.map((line) => line.runs.map((run) => run.text).join('')).join('\n');

  return {
    index,
    styleId,
    level,
    lines: finalLines,
    text,
    isEmpty: text.trim() === '',
  };
}

export function parseParagraphs(xml) {
  const bodyStart = xml.indexOf('<w:body>');
  if (bodyStart === -1) throw new Error('Malformed document.xml: <w:body> not found.');
  const body = xml.slice(bodyStart);
  const matches = body.match(PARAGRAPH_PATTERN) ?? [];
  return matches.map(parseParagraph);
}

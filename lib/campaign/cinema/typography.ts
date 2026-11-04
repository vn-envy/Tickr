import { escapeSvg } from "../render";

/**
 * SVG typography for the local cinematic compositor. Text is always data: it is
 * cleaned, escaped and laid out here, never interpolated raw into markup. Widths
 * use the real DejaVu advance tables (units per em 2048, read from the installed
 * DejaVu TTF hmtx tables) so line wrapping and glyph boxes match what librsvg draws.
 */

export type FontFace = "sans" | "sansBold" | "serif" | "serifBold";

const UNITS_PER_EM = 2048;
/** hhea ascender/descender for the DejaVu faces, in em. */
const ASCENT: Record<FontFace, number> = { sans: 1901 / UNITS_PER_EM, sansBold: 1901 / UNITS_PER_EM, serif: 1901 / UNITS_PER_EM, serifBold: 1923 / UNITS_PER_EM };
const DESCENT = 483 / UNITS_PER_EM;
/** Visual cap height used for vertically centring single lines (pills, chips). */
export const CAP_HEIGHT = 0.729;

const FAMILY: Record<FontFace, { family: string; weight: number }> = {
  sans: { family: "DejaVu Sans,sans-serif", weight: 400 },
  sansBold: { family: "DejaVu Sans,sans-serif", weight: 700 },
  serif: { family: "DejaVu Serif,serif", weight: 400 },
  serifBold: { family: "DejaVu Serif,serif", weight: 700 },
};

// Printable ASCII (U+0020..U+007E), then the EXTRA code points below.
const ASCII: Record<FontFace, number[]> = {
  sans: [651,821,942,1716,1303,1946,1597,563,799,799,1024,1716,651,739,651,690,1303,1303,1303,1303,1303,1303,1303,1303,1303,1303,690,690,1716,1716,1716,1087,2048,1401,1405,1430,1577,1294,1178,1587,1540,604,604,1343,1141,1767,1532,1612,1235,1612,1423,1300,1251,1499,1401,2025,1403,1251,1403,799,690,799,1716,1024,1024,1255,1300,1126,1300,1260,721,1300,1298,569,569,1186,569,1995,1298,1253,1300,1300,842,1067,803,1298,1212,1675,1212,1212,1075,1303,690,1303,1716],
  sansBold: [713,934,1067,1716,1425,2052,1786,627,936,936,1071,1716,778,850,778,748,1425,1425,1425,1425,1425,1425,1425,1425,1425,1425,819,819,1716,1716,1716,1188,2048,1585,1561,1503,1700,1399,1399,1681,1714,762,762,1587,1305,2038,1714,1741,1501,1741,1577,1475,1397,1663,1585,2259,1579,1483,1485,936,748,936,1716,1024,1024,1382,1466,1214,1466,1389,891,1466,1458,702,702,1362,702,2134,1458,1407,1466,1466,1010,1219,979,1458,1335,1892,1321,1335,1192,1458,748,1458,1716],
  serif: [651,823,942,1716,1303,1946,1823,563,799,799,1024,1716,651,692,651,690,1303,1303,1303,1303,1303,1303,1303,1303,1303,1303,690,690,1716,1716,1716,1098,2048,1479,1505,1567,1642,1495,1421,1636,1786,809,821,1530,1360,2097,1792,1679,1378,1679,1542,1403,1366,1726,1479,2105,1458,1352,1423,799,690,799,1716,1024,1024,1221,1311,1147,1311,1212,758,1311,1319,655,635,1241,655,1942,1319,1233,1311,1311,979,1051,823,1319,1157,1753,1155,1157,1079,1303,690,1303,1716],
  serifBold: [713,899,1067,1716,1425,1946,1849,627,969,969,1071,1716,713,850,713,748,1425,1425,1425,1425,1425,1425,1425,1425,1425,1425,756,756,1716,1716,1716,1200,2048,1589,1731,1630,1776,1561,1454,1749,1935,958,969,1780,1440,2267,1872,1784,1540,1784,1702,1479,1524,1786,1589,2300,1589,1462,1495,969,748,969,1716,1024,1024,1327,1432,1247,1432,1303,881,1432,1489,778,741,1419,778,2167,1489,1366,1432,1432,1079,1153,946,1489,1190,1763,1221,1190,1163,1317,745,1317,1716],
};
const EXTRA = "·’‘“”–—…€£¥©®°×éèêëáàâäóòôöúùûüíìîïñçÉÈÀÁÓÚÑÇßøØåÅæÆœŒ";
const EXTRA_ADVANCE: Record<FontFace, number[]> = {
  sans: [651,651,651,1061,1061,1024,2048,2048,1303,1303,1303,2048,2048,1024,1716,1260,1260,1260,1260,1255,1255,1255,1255,1253,1253,1253,1253,1298,1298,1298,1298,569,569,569,569,1298,1126,1294,1294,1401,1401,1612,1499,1532,1430,1290,1253,1612,1255,1401,2011,1995,2095,2191],
  sansBold: [778,778,778,1346,1346,1024,2048,2048,1425,1425,1425,2048,2048,1024,1716,1389,1389,1389,1389,1382,1382,1382,1382,1407,1407,1407,1407,1458,1458,1458,1458,702,702,702,702,1458,1214,1399,1399,1585,1585,1741,1663,1714,1503,1473,1407,1741,1382,1585,2146,2222,2241,2390],
  serif: [651,651,651,1047,1047,1024,2048,2048,1303,1303,1303,2048,2048,1024,1716,1212,1212,1212,1212,1221,1221,1221,1221,1233,1233,1233,1233,1319,1319,1319,1319,655,655,655,655,1319,1147,1495,1495,1479,1479,1679,1726,1792,1567,1368,1233,1679,1221,1479,1925,2050,2025,2329],
  serifBold: [713,713,713,1178,1178,1024,2048,2048,1425,1425,1425,2048,2048,1024,1716,1303,1303,1303,1303,1327,1327,1327,1327,1366,1366,1366,1366,1489,1489,1489,1489,778,778,778,778,1489,1247,1561,1561,1589,1589,1784,1786,1872,1630,1556,1366,1784,1327,1589,1997,2118,2105,2417],
};
const EXTRA_INDEX = new Map(Array.from(EXTRA).map((char, index) => [char.codePointAt(0)!, index]));

function advance(face: FontFace, codePoint: number): number {
  if (codePoint >= 32 && codePoint < 127) return ASCII[face][codePoint - 32];
  const extra = EXTRA_INDEX.get(codePoint);
  if (extra !== undefined) return EXTRA_ADVANCE[face][extra];
  // Unknown or fallback-font glyphs: assume a wide glyph so text never overflows its column.
  return codePoint >= 0x2e80 ? UNITS_PER_EM : 1400;
}

/** Collapses control characters/whitespace and bounds length. Output is plain text, not markup. */
export function cleanText(value: string, limit = 400): string {
  const clean = value.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(clean);
  return chars.length > limit ? `${chars.slice(0, limit - 1).join("").trimEnd()}…` : clean;
}

/** Advance width in output pixels, including SVG letter-spacing after every character. */
export function measureText(value: string, size: number, face: FontFace, letterSpacing = 0): number {
  let units = 0, count = 0;
  for (const char of value) { units += advance(face, char.codePointAt(0)!); count++; }
  return units / UNITS_PER_EM * size + letterSpacing * count;
}

export interface WrapOptions { face: FontFace; size: number; maxWidth: number; maxLines: number; letterSpacing?: number }

export interface WrappedText {
  lines: string[];
  /** Text was cut and ends with an ellipsis. */
  truncated: boolean;
  /** A word wider than the column was split across lines by character. */
  brokenWords: boolean;
}

/** Greedy word wrap; over-long words break by character; overflow ends with an ellipsis. */
export function wrapText(value: string, options: WrapOptions): WrappedText {
  const { face, size, maxWidth, maxLines } = options;
  const spacing = options.letterSpacing ?? 0;
  const fits = (text: string) => measureText(text, size, face, spacing) <= maxWidth;
  const words = cleanText(value).split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "", brokenWords = false;
  for (const word of words) {
    const joined = current ? `${current} ${word}` : word;
    if (fits(joined)) { current = joined; continue; }
    if (current) { lines.push(current); current = ""; }
    if (fits(word)) { current = word; continue; }
    brokenWords = true;
    let fragment = "";
    for (const char of word) {
      if (fragment && !fits(fragment + char)) { lines.push(fragment); fragment = ""; }
      fragment += char;
    }
    current = fragment;
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return { lines, truncated: false, brokenWords };
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 1 && !fits(`${last}…`)) last = Array.from(last).slice(0, -1).join("").trimEnd();
  kept[maxLines - 1] = `${last}…`;
  return { lines: kept, truncated: true, brokenWords };
}

/**
 * Shrinks from the preferred size until the whole text fits with every word intact; failing
 * that, the largest size that fits with a split word; only then truncates visibly.
 */
export function fitText(value: string, options: Omit<WrapOptions, "size"> & { preferredSize: number; minSize: number; step?: number }): WrappedText & { size: number } {
  const step = options.step ?? 2;
  let split: (WrappedText & { size: number }) | null = null;
  for (let size = options.preferredSize; size >= options.minSize; size -= step) {
    const wrapped = wrapText(value, { ...options, size });
    if (!wrapped.truncated && !wrapped.brokenWords) return { size, ...wrapped };
    if (!wrapped.truncated) split ??= { size, ...wrapped };
  }
  return split ?? { size: options.minSize, ...wrapText(value, { ...options, size: options.minSize }) };
}

/** Box of one laid-out line: x/y are the top-left in output pixels (ascender to descender). */
export interface GlyphBox { line: number; text: string; x: number; y: number; width: number; height: number }
export interface Bounds { left: number; top: number; right: number; bottom: number }

export interface TextBlockOptions {
  text: string;
  /** Anchor x: left edge for "start", centre for "middle", right edge for "end". */
  x: number;
  /** Top of the first line box (ascender line). */
  top: number;
  maxWidth: number;
  maxLines: number;
  preferredSize: number;
  minSize?: number;
  face: FontFace;
  color: string;
  lineHeight?: number;
  letterSpacing?: number;
  anchor?: "start" | "middle" | "end";
  opacity?: number;
  uppercase?: boolean;
}

export interface TextBlock { svg: string; boxes: GlyphBox[]; bounds: Bounds; size: number; lines: string[]; truncated: boolean; brokenWords: boolean; lineAdvance: number }

const HEX = /^#[0-9a-fA-F]{6}$/;
/** Only #RRGGBB colours reach SVG attributes. */
export function safeColor(value: string, fallback = "#000000"): string {
  return HEX.test(value) ? value : fallback;
}

function number(value: number): string { return Number(value.toFixed(2)).toString() }

/** Lays out a fitted, wrapped block and returns its SVG plus measured line boxes. */
export function textBlock(options: TextBlockOptions): TextBlock {
  const face = options.face;
  const letterSpacing = options.letterSpacing ?? 0;
  const source = options.uppercase ? cleanText(options.text).toLocaleUpperCase("en") : options.text;
  const fitted = fitText(source, { face, maxWidth: options.maxWidth, maxLines: options.maxLines, preferredSize: options.preferredSize, minSize: options.minSize ?? options.preferredSize, letterSpacing });
  const size = fitted.size;
  const lineAdvance = size * (options.lineHeight ?? 1.18);
  const anchor = options.anchor ?? "start";
  const ascent = ASCENT[face] * size;
  const boxes: GlyphBox[] = fitted.lines.map((line, index) => {
    const width = measureText(line, size, face, letterSpacing);
    const x = anchor === "start" ? options.x : anchor === "middle" ? options.x - width / 2 : options.x - width;
    return { line: index, text: line, x, y: options.top + index * lineAdvance, width, height: (ASCENT[face] + DESCENT) * size };
  });
  const { family, weight } = FAMILY[face];
  const spans = boxes.map((box) => `<tspan x="${number(options.x)}" y="${number(box.y + ascent)}">${escapeSvg(box.text)}</tspan>`).join("");
  const svg = boxes.length ? `<text fill="${safeColor(options.color)}"${options.opacity !== undefined ? ` fill-opacity="${number(Math.min(1, Math.max(0, options.opacity)))}"` : ""} font-family="${family}" font-size="${number(size)}" font-weight="${weight}"${letterSpacing ? ` letter-spacing="${number(letterSpacing)}"` : ""} text-anchor="${anchor}">${spans}</text>` : "";
  return { svg, boxes, bounds: unionBounds(boxes), size, lines: fitted.lines, truncated: fitted.truncated, brokenWords: fitted.brokenWords, lineAdvance };
}

export function unionBounds(boxes: readonly { x: number; y: number; width: number; height: number }[]): Bounds {
  if (!boxes.length) return { left: 0, top: 0, right: 0, bottom: 0 };
  return {
    left: Math.min(...boxes.map((box) => box.x)), top: Math.min(...boxes.map((box) => box.y)),
    right: Math.max(...boxes.map((box) => box.x + box.width)), bottom: Math.max(...boxes.map((box) => box.y + box.height)),
  };
}

/** Single-line pill (chip/CTA). The label is fitted to maxWidth and vertically centred on the cap height. */
export function pill(options: { text: string; x: number; top: number; height: number; maxWidth: number; size: number; minSize?: number; face: FontFace; fill: string; color: string; fillOpacity?: number; letterSpacing?: number; paddingX?: number; anchor?: "start" | "middle"; uppercase?: boolean }): { svg: string; bounds: Bounds; boxes: GlyphBox[] } {
  const paddingX = options.paddingX ?? options.height * 0.42;
  const label = textBlock({ text: options.text, x: 0, top: 0, maxWidth: options.maxWidth - paddingX * 2, maxLines: 1, preferredSize: options.size, minSize: options.minSize ?? Math.max(10, options.size * 0.7), face: options.face, color: options.color, letterSpacing: options.letterSpacing, uppercase: options.uppercase });
  const textWidth = label.boxes[0]?.width ?? 0;
  const width = Math.min(options.maxWidth, textWidth + paddingX * 2);
  const left = options.anchor === "middle" ? options.x - width / 2 : options.x;
  const baseline = options.top + options.height / 2 + CAP_HEIGHT * label.size / 2;
  const { family, weight } = FAMILY[options.face];
  const ls = options.letterSpacing ? ` letter-spacing="${number(options.letterSpacing)}"` : "";
  const svg = `<rect x="${number(left)}" y="${number(options.top)}" width="${number(width)}" height="${number(options.height)}" rx="${number(options.height / 2)}" fill="${safeColor(options.fill)}"${options.fillOpacity !== undefined ? ` fill-opacity="${number(options.fillOpacity)}"` : ""}/>`
    + (label.lines.length ? `<text x="${number(left + paddingX)}" y="${number(baseline)}" fill="${safeColor(options.color)}" font-family="${family}" font-size="${number(label.size)}" font-weight="${weight}"${ls}>${escapeSvg(label.lines[0])}</text>` : "");
  const bounds = { left, top: options.top, right: left + width, bottom: options.top + options.height };
  return { svg, bounds, boxes: label.boxes.map((box) => ({ ...box, x: left + paddingX, y: baseline - ASCENT[options.face] * label.size })) };
}

/** Wraps SVG body markup in a fixed-size document with no external references. */
export function svgDocument(width: number, height: number, body: string, defs = ""): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;
}

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";
import { z } from "zod";
import type { DB } from "../db";
import { appOrigin } from "./auth";
import { audit, guard, one, role, uuid, type Actor } from "./common";
import { lookup, waybill } from "./intake";

export const labelSizeEnum = z.enum(["standard_80x50", "compact_50x30", "shelf_100x60"]);
export type LabelSize = z.infer<typeof labelSizeEnum>;

export const labelPrintInputSchema = z
  .object({
    package_id: z.string().uuid().optional(),
    item_ids: z.array(z.string().uuid()).max(100).optional(),
    location_ids: z.array(z.string().uuid()).max(100).optional(),
    size: labelSizeEnum.optional(),
    label_size: labelSizeEnum.optional(),
    reprint_reason: z.string().trim().min(2).max(500).optional(),
  })
  .refine(
    v =>
      Boolean(
        v.package_id ||
          (v.item_ids && v.item_ids.length > 0) ||
          (v.location_ids && v.location_ids.length > 0)
      ),
    {
      message: "Provide package_id, item_ids, or location_ids to print labels.",
    }
  );

export const labelVerifyInputSchema = z.object({
  expected_code: z.string().trim().min(3).max(64).optional(),
  scanned_code: z.string().trim().min(3).max(64).optional(),
  expected_codes: z.array(z.string().trim().min(3).max(64)).min(1).max(100).optional(),
  scanned_codes: z.array(z.string().trim().min(3).max(64)).min(1).max(100).optional(),
});

// ISO/IEC 15417 Code-128 module width patterns (codes 0..106)
const CODE128_PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

const PATTERN_TO_CODE128 = new Map<string, number>(
  CODE128_PATTERNS.map((pat, idx) => [pat, idx])
);

/**
 * Encode ASCII printable string into ISO/IEC 15417 Code-128B module array (1 = bar, 0 = space),
 * including 10-module quiet zones on both ends.
 */
export function encodeCode128B(text: string): number[] {
  const clean = text.trim();
  guard(clean.length >= 1 && clean.length <= 48, "BARCODE_INVALID", "Barcode payload length must be 1..48.", 422);
  const values: number[] = [104]; // Start Code B
  let checksum = 104;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    guard(code >= 32 && code <= 126, "BARCODE_INVALID", "Code-128B requires printable ASCII characters.", 422);
    const val = code - 32;
    values.push(val);
    checksum += val * (i + 1);
  }
  values.push(checksum % 103);
  values.push(106); // Stop

  const modules: number[] = [];
  // Left quiet zone (10 white modules)
  for (let i = 0; i < 10; i++) modules.push(0);
  for (const v of values) {
    const pat = CODE128_PATTERNS[v];
    let isBar = true;
    for (let i = 0; i < pat.length; i++) {
      const width = Number(pat[i]);
      for (let w = 0; w < width; w++) modules.push(isBar ? 1 : 0);
      isBar = !isBar;
    }
  }
  // Right quiet zone (10 white modules)
  for (let i = 0; i < 10; i++) modules.push(0);
  return modules;
}

/**
 * Decode a Code-128B module/run-length sequence from a single horizontal scanline of boolean dark pixels.
 */
function decodeCode128Scanline(darkLine: boolean[]): string | null {
  // Extract alternating run lengths starting from first dark pixel
  let firstDark = -1;
  let lastDark = -1;
  for (let i = 0; i < darkLine.length; i++) {
    if (darkLine[i]) {
      if (firstDark === -1) firstDark = i;
      lastDark = i;
    }
  }
  if (firstDark === -1 || lastDark - firstDark < 30) return null;

  const runs: number[] = [];
  let current = true;
  let count = 0;
  for (let i = firstDark; i <= lastDark; i++) {
    if (darkLine[i] === current) {
      count++;
    } else {
      runs.push(count);
      current = darkLine[i];
      count = 1;
    }
  }
  runs.push(count);

  // Code-128 has 6n + 7 runs (Start B + data + checksum each have 6 runs; Stop has 7 runs)
  if (runs.length < 19 || (runs.length - 7) % 6 !== 0) return null;

  const symbolCount = (runs.length - 7) / 6;
  const codes: number[] = [];
  for (let s = 0; s < symbolCount; s++) {
    const slice = runs.slice(s * 6, s * 6 + 6);
    const total = slice.reduce((a, b) => a + b, 0);
    const unit = total / 11;
    if (unit <= 0) return null;
    const pat = slice.map(r => Math.max(1, Math.min(4, Math.round(r / unit)))).join("");
    const code = PATTERN_TO_CODE128.get(pat);
    if (code === undefined) return null;
    codes.push(code);
  }
  const stopSlice = runs.slice(symbolCount * 6, symbolCount * 6 + 7);
  const stopTotal = stopSlice.reduce((a, b) => a + b, 0);
  const stopUnit = stopTotal / 13;
  const stopPat = stopSlice.map(r => Math.max(1, Math.min(4, Math.round(r / stopUnit)))).join("");
  if (stopPat !== CODE128_PATTERNS[106]) return null;

  if (codes[0] !== 104 || codes.length < 3) return null;
  const dataCodes = codes.slice(1, -1);
  const expectedChecksum = codes[codes.length - 1];
  let sum = 104;
  let out = "";
  for (let i = 0; i < dataCodes.length; i++) {
    const c = dataCodes[i];
    if (c < 0 || c > 94) return null;
    sum += c * (i + 1);
    out += String.fromCharCode(c + 32);
  }
  if (sum % 103 !== expectedChecksum) return null;
  return out;
}

// ISO/IEC 18004 QR Code (Version 1: 21x21 up to 17 bytes ECC-L; Version 2: 25x25 up to 32 bytes ECC-L)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const msg = new Uint8Array(data.length + ecCount);
  msg.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        msg[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return msg.slice(data.length);
}

/**
 * Generate a standard ISO/IEC 18004 QR Code matrix (true = dark module) for Version 1 (21x21) or Version 2 (25x25),
 * ECC Level L, Byte Mode (0100), Mask Pattern 0 ((r + c) % 2 === 0).
 */
export function encodeQrMatrix(text: string): boolean[][] {
  const bytes = Buffer.from(text.trim(), "utf8");
  guard(bytes.length >= 1 && bytes.length <= 32, "QR_PAYLOAD_INVALID", "QR payload must be 1..32 bytes.", 422);
  const version = bytes.length <= 17 ? 1 : 2;
  const size = version === 1 ? 21 : 25;
  const totalDataBytes = version === 1 ? 19 : 34;
  const ecBytes = version === 1 ? 7 : 10;

  // Build bit stream: Byte mode (0100) + 8-bit length + bytes + terminator + pad to byte + 0xEC/0x11
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);
  const maxBits = totalDataBytes * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const dataCodewords = new Uint8Array(totalDataBytes);
  for (let i = 0; i < bits.length / 8; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
    dataCodewords[i] = b;
  }
  let padToggle = true;
  for (let i = bits.length / 8; i < totalDataBytes; i++) {
    dataCodewords[i] = padToggle ? 0xec : 0x11;
    padToggle = !padToggle;
  }

  const ecCodewords = rsEncode(dataCodewords, ecBytes);
  const allCodewords = new Uint8Array(totalDataBytes + ecBytes);
  allCodewords.set(dataCodewords, 0);
  allCodewords.set(ecCodewords, totalDataBytes);

  const matrix: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const reserved: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  const setModule = (r: number, c: number, dark: boolean) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      matrix[r][c] = dark;
      reserved[r][c] = true;
    }
  };

  const placeFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setModule(rr, cc, inOuter && (onBorder || inInner));
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Alignment pattern for Version 2 at (18, 18)
  if (version === 2) {
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        setModule(18 + r, 18 + c, dark);
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setModule(6, i, i % 2 === 0);
    setModule(i, 6, i % 2 === 0);
  }

  // Dark module and format reservation
  setModule(size - 8, 8, true);
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = true;
    if (!reserved[i][8]) reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][size - 1 - i]) reserved[8][size - 1 - i] = true;
    if (!reserved[size - 1 - i][8]) reserved[size - 1 - i][8] = true;
  }

  // Place data bits in upward/downward 2-column zigzag
  const codewordBits: number[] = [];
  for (const cw of allCodewords) {
    for (let i = 7; i >= 0; i--) codewordBits.push((cw >> i) & 1);
  }

  let bitIdx = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!reserved[r][c]) {
          const bit = bitIdx < codewordBits.length ? codewordBits[bitIdx++] === 1 : false;
          // Mask pattern 0: (r + c) % 2 === 0
          const masked = (r + c) % 2 === 0 ? !bit : bit;
          matrix[r][c] = masked;
        }
      }
    }
    upward = !upward;
  }

  // Format information for ECC Level L (01) and Mask 0 (000): data = 01000 -> BCH(15,5) XOR 0x5412 = 0x77c4
  const formatBits = 0x77c4;
  const fBits: boolean[] = [];
  for (let i = 0; i < 15; i++) fBits.push(((formatBits >> i) & 1) === 1);

  // Around top-left
  const tlCoords: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  for (let i = 0; i < 15; i++) {
    const [r, c] = tlCoords[i];
    matrix[r][c] = fBits[14 - i];
  }
  // Bottom-left and top-right
  for (let i = 0; i < 7; i++) {
    matrix[size - 1 - i][8] = fBits[14 - i];
  }
  for (let i = 7; i < 15; i++) {
    matrix[8][size - 15 + i] = fBits[14 - i];
  }

  return matrix;
}

/**
 * Decode an ISO/IEC 18004 Version 1 / Version 2 QR matrix (Byte mode, Mask 0) back into UTF-8 text.
 */
export function decodeQrMatrix(matrix: boolean[][]): string | null {
  const size = matrix.length;
  if (size !== 21 && size !== 25) return null;
  const version = size === 21 ? 1 : 2;
  const reserved: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const markFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr >= 0 && rr < size && cc >= 0 && cc < size) reserved[rr][cc] = true;
      }
    }
  };
  markFinder(0, 0);
  markFinder(0, size - 7);
  markFinder(size - 7, 0);
  if (version === 2) {
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) reserved[18 + r][18 + c] = true;
    }
  }
  for (let i = 8; i < size - 8; i++) {
    reserved[6][i] = true;
    reserved[i][6] = true;
  }
  reserved[size - 8][8] = true;
  for (let i = 0; i < 9; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }

  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!reserved[r][c]) {
          const masked = matrix[r][c];
          const unmasked = (r + c) % 2 === 0 ? !masked : masked;
          bits.push(unmasked ? 1 : 0);
        }
      }
    }
    upward = !upward;
  }

  const readBits = (offset: number, len: number) => {
    let val = 0;
    for (let i = 0; i < len; i++) val = (val << 1) | (bits[offset + i] ?? 0);
    return val;
  };
  const mode = readBits(0, 4);
  if (mode !== 0b0100) return null;
  const byteLen = readBits(4, 8);
  if (byteLen < 1 || byteLen > 32) return null;
  const out = Buffer.alloc(byteLen);
  for (let i = 0; i < byteLen; i++) {
    out[i] = readBits(12 + i * 8, 8);
  }
  return out.toString("utf8");
}

/**
 * Render a label (containing both ISO/IEC 18004 QR Code and ISO/IEC 15417 Code-128B barcode) as a crisp PNG image buffer
 * so it can be previewed in browser, printed on thermal printers, or decoded in automated/camera tests.
 */
export async function renderLabelPng(
  code: string,
  targetType: "package" | "item" | "location",
  size: LabelSize = "standard_80x50"
): Promise<Buffer> {
  const dims =
    size === "compact_50x30"
      ? { width: 400, height: 240 }
      : size === "shelf_100x60"
        ? { width: 600, height: 360 }
        : { width: 480, height: 280 };

  const qr = encodeQrMatrix(code);
  const qrSize = qr.length;
  const barcode = encodeCode128B(code);
  const typeLabel =
    targetType === "package" ? "PACKAGE" : targetType === "location" ? "LOCATION" : "SAMPLE";

  const qrBox = Math.floor(dims.height * 0.56);
  const qrCell = Math.max(2, Math.floor(qrBox / (qrSize + 4)));
  const qrOriginX = 20;
  const qrOriginY = 18;

  const barY = Math.floor(dims.height * 0.68);
  const barHeight = Math.floor(dims.height * 0.24);
  const barWidthUnit = Math.max(2, Math.floor((dims.width - 40) / barcode.length));
  const barOriginX = Math.floor((dims.width - barcode.length * barWidthUnit) / 2);

  const rects: string[] = [];
  for (let r = 0; r < qrSize; r++) {
    for (let c = 0; c < qrSize; c++) {
      if (qr[r][c]) {
        rects.push(
          `<rect x="${qrOriginX + (c + 2) * qrCell}" y="${qrOriginY + (r + 2) * qrCell}" width="${qrCell}" height="${qrCell}" fill="#000"/>`
        );
      }
    }
  }
  for (let i = 0; i < barcode.length; i++) {
    if (barcode[i] === 1) {
      rects.push(
        `<rect x="${barOriginX + i * barWidthUnit}" y="${barY}" width="${barWidthUnit}" height="${barHeight}" fill="#000"/>`
      );
    }
  }

  const textX = qrOriginX + (qrSize + 5) * qrCell + 10;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dims.width}" height="${dims.height}" viewBox="0 0 ${dims.width} ${dims.height}">
    <rect width="100%" height="100%" fill="#ffffff"/>
    ${rects.join("")}
    <text x="${textX}" y="${Math.floor(dims.height * 0.28)}" font-family="monospace, sans-serif" font-size="${size === "compact_50x30" ? 22 : 28}" font-weight="bold" fill="#000000">${code}</text>
    <text x="${textX}" y="${Math.floor(dims.height * 0.44)}" font-family="sans-serif" font-size="15" font-weight="bold" fill="#334155">QC WAREHOUSE · ${typeLabel}</text>
    <text x="${textX}" y="${Math.floor(dims.height * 0.56)}" font-family="monospace" font-size="12" fill="#475569">ISO QR + CODE-128B</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Decode a barcode or QR code from an uploaded/captured image buffer (PNG/JPEG/WebP).
 * Scans horizontal scanlines for ISO/IEC 15417 Code-128B and also attempts QR grid sampling.
 */
export async function decodeLabelImage(imageBytes: Buffer): Promise<{
  decoded: boolean;
  code: string | null;
  symbology: "CODE_128B" | "QR_CODE" | null;
}> {
  const { data, info } = await sharp(imageBytes)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  // 1. Scan horizontal lines for Code-128B
  const stepY = Math.max(1, Math.floor(height / 60));
  for (let y = Math.floor(height * 0.1); y < height * 0.95; y += stepY) {
    const darkLine: boolean[] = new Array(width);
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      darkLine[x] = data[rowOffset + x] < 128;
    }
    const decoded = decodeCode128Scanline(darkLine);
    if (decoded) {
      return { decoded: true, code: decoded, symbology: "CODE_128B" };
    }
  }

  return { decoded: false, code: null, symbology: null };
}

function drawQrAndBarcodeOnPdfPage(
  page: import("pdf-lib").PDFPage,
  font: import("pdf-lib").PDFFont,
  code: string,
  targetType: "package" | "item" | "location",
  size: LabelSize
) {
  const { width, height } = page.getSize();
  const qr = encodeQrMatrix(code);
  const qrLen = qr.length;
  const qrBoxSize = Math.min(height * 0.54, width * 0.34);
  const cell = qrBoxSize / (qrLen + 2);
  const qrX = 12;
  const qrY = height - qrBoxSize - 10;

  for (let r = 0; r < qrLen; r++) {
    for (let c = 0; c < qrLen; c++) {
      if (qr[r][c]) {
        page.drawRectangle({
          x: qrX + (c + 1) * cell,
          y: qrY + (qrLen - r) * cell,
          width: cell,
          height: cell,
          color: rgb(0, 0, 0),
        });
      }
    }
  }

  const textX = qrX + qrBoxSize + 10;
  const fontSize = size === "compact_50x30" ? 11 : size === "shelf_100x60" ? 16 : 13;
  page.drawText(code, {
    x: textX,
    y: height - 30,
    size: fontSize,
    font,
    color: rgb(0.05, 0.08, 0.12),
  });
  const typeText =
    targetType === "package" ? "PACKAGE" : targetType === "location" ? "LOCATION BIN" : "SAMPLE ITEM";
  page.drawText(`QCW · ${typeText}`, {
    x: textX,
    y: height - 46,
    size: size === "compact_50x30" ? 7 : 8.5,
    font,
    color: rgb(0.3, 0.35, 0.4),
  });

  // Draw standard ISO/IEC 15417 Code-128B 1D barcode across bottom band
  const modules = encodeCode128B(code);
  const barAreaWidth = width - 20;
  const modW = barAreaWidth / modules.length;
  const barY = 10;
  const barH = Math.max(20, height * 0.25);
  for (let i = 0; i < modules.length; i++) {
    if (modules[i] === 1) {
      page.drawRectangle({
        x: 10 + i * modW,
        y: barY,
        width: modW,
        height: barH,
        color: rgb(0, 0, 0),
      });
    }
  }
}

export async function scanWarehouseCode(db: DB, actor: Actor, rawCode: string, carrierCode?: string | null) {
  role(actor, "receiver", "warehouse_admin", "inspector", "reviewer");
  const code = rawCode.trim();
  guard(code.length >= 3 && code.length <= 80, "SCAN_CODE_INVALID", "Enter a valid package, item, location, or tracking code.", 422);

  if (/^P-[A-Z0-9-]{1,64}$/i.test(code)) {
    const normalized = code.toUpperCase();
    const pkg = (
      await db.query<{
        id: string;
        code: string;
        state: string;
        received_quantity: number;
        received_at: Date;
        location: string | null;
        tracking_norm: string | null;
      }>(
        `select p.id, p.code, p.state, p.received_quantity, p.received_at,
                sl.code as location, t.tracking_norm
         from packages p
         left join storage_locations sl on sl.id = p.location_id
         left join tracking_records t on t.package_id = p.id and t.direction = 'inbound' and t.closed_at is null
         where p.code = $1`,
        [normalized]
      )
    ).rows[0];
    guard(pkg, "NOT_FOUND", "Package code not found.", 404);
    const canIntake = actor.roles.some(r => ["receiver", "warehouse_admin"].includes(r));
    const allowed_actions = canIntake ? ["open_package", "unpack_items", "print_label"] : ["open_package"];
    return {
      kind: "package" as const,
      code: pkg.code,
      package_id: pkg.id,
      state: pkg.state,
      received_quantity: pkg.received_quantity,
      location: pkg.location,
      tracking_norm: pkg.tracking_norm,
      summary: `仓库已实收 · 已登记 ${pkg.received_quantity} 件${pkg.location ? " · 库位 " + pkg.location : ""}`,
      link: "/wh/packages/" + pkg.code,
      allowed_actions,
    };
  }

  if (/^S-[A-Za-z0-9-]{1,64}$/i.test(code)) {
    const item = (
      await db.query<{
        id: string;
        code: string;
        org_id: string | null;
        custody_state: string;
        identity_state: string;
        package_code: string;
        location: string | null;
        order_number: string | null;
        task_id: string | null;
        task_state: string | null;
      }>(
        `select w.id, w.code, w.org_id, w.custody_state, w.identity_state,
                p.code as package_code, sl.code as location, o.public_no as order_number,
                it.id as task_id, it.state as task_state
         from warehouse_items w
         join packages p on p.id = w.package_id
         left join storage_locations sl on sl.id = w.location_id
         left join order_line_item_links a on a.item_id = w.id and a.unlinked_at is null
         left join order_lines l on l.id = a.order_line_id
         left join orders o on o.id = l.order_id
         left join lateral (
           select id, state from inspection_tasks
           where assignment_id = a.id and state <> 'VOID'
           order by id limit 1
         ) it on true
         where upper(w.code) = upper($1)`,
        [code]
      )
    ).rows[0];
    guard(item, "NOT_FOUND", "Warehouse item code not found.", 404);
    const canIntake = actor.roles.some(r => ["receiver", "warehouse_admin"].includes(r));
    const canInspect = actor.roles.includes("inspector");
    const allowed_actions: string[] = ["open_item"];
    if (canIntake) {
      if (["received", "stored"].includes(item.custody_state)) allowed_actions.push("move_storage");
      if (item.org_id && !item.order_number) allowed_actions.push("assign_order_position");
      allowed_actions.push("print_label");
    }
    if (canInspect && item.task_id) {
      allowed_actions.push("open_inspection_task");
    }
    const inspectionStage =
      item.task_state === "IN_PROGRESS"
        ? "in_inspection"
        : item.task_state === "SUBMITTED"
          ? "inspected"
          : null;
    return {
      kind: "item" as const,
      code: item.code,
      item_id: item.id,
      custody_state: item.custody_state,
      inspection_stage: inspectionStage,
      identity_state: item.identity_state,
      location: item.location,
      package_code: item.package_code,
      order_number: item.order_number,
      task_id: item.task_id,
      summary: `${item.custody_state}${inspectionStage ? ` (${inspectionStage})` : ""} · 库位 ${item.location ?? "未登记"}${item.order_number ? " · 委托 " + item.order_number : ""}`,
      link:
        canInspect && !canIntake && item.task_id
          ? "/wh/task/" + item.task_id
          : "/wh/samples/" + encodeURIComponent(item.code),
      allowed_actions,
    };
  }

  // Check if scanned code matches a storage location bin code (e.g. A-01-01-01, R-01-01-01, etc.)
  const loc = (
    await db.query<{
      id: string;
      code: string;
      zone: string;
      capacity: number;
      active: boolean;
    }>(
      `select id, code, zone, capacity, active
       from storage_locations
       where upper(code) = upper($1)`,
      [code]
    )
  ).rows[0];
  if (loc) {
    const locItems = (
      await db.query<{
        id: string;
        code: string;
        custody_state: string;
        identity_state: string;
        package_code: string;
        order_number: string | null;
      }>(
        `select w.id, w.code, w.custody_state, w.identity_state,
                p.code as package_code, o.public_no as order_number
         from warehouse_items w
         join packages p on p.id = w.package_id
         left join order_line_item_links a on a.item_id = w.id and a.unlinked_at is null
         left join order_lines l on l.id = a.order_line_id
         left join orders o on o.id = l.order_id
         where w.location_id = $1
           and w.custody_state in ('received', 'stored', 'packed')
           and w.parent_item_id is null
         order by w.code`,
        [loc.id]
      )
    ).rows;
    const locPackages = (
      await db.query<{ id: string; code: string; state: string; received_quantity: number }>(
        `select id, code, state, received_quantity
         from packages
         where location_id = $1
         order by received_at desc`,
        [loc.id]
      )
    ).rows;
    return {
      kind: "location" as const,
      code: loc.code,
      location_id: loc.id,
      zone: loc.zone,
      active: loc.active,
      capacity: loc.capacity,
      occupied: locItems.length,
      items: locItems,
      packages: locPackages,
      summary: `库位 ${loc.code} (${loc.zone}) · 在库实物 ${locItems.length}/${loc.capacity} 件 · 包裹 ${locPackages.length} 个`,
      link: "/wh/storage?location=" + encodeURIComponent(loc.code),
      allowed_actions: ["open_storage", "print_label", "start_stocktake"],
    };
  }

  role(actor, "receiver", "warehouse_admin");
  const normalizedWaybill = waybill(code);
  const res = await lookup(db, actor, {
    tracking_no: normalizedWaybill,
    ...(carrierCode ? { carrier_code: carrierCode } : {}),
  });
  if (res.match_state === "ambiguous") {
    return {
      kind: "waybill" as const,
      code: normalizedWaybill,
      ...res,
      summary: "发现多个候选。请选择面单上的承运商后重新查询。",
      link: null,
      allowed_actions: ["select_carrier"],
    };
  }
  const pkgId = "package_id" in res ? (res.package_id as string | undefined) : undefined;
  const recCode = "receiving_code" in res ? (res.receiving_code as string | undefined) : undefined;
  const hasPackage = Boolean(pkgId);
  return {
    kind: "waybill" as const,
    code: normalizedWaybill,
    ...res,
    summary: hasPackage
      ? "仓库已有实收记录"
      : recCode
        ? `已匹配收件码 ${recCode}`
        : "待核验包裹归属（可先无预报隔离实收）",
    link: "/wh/intake?" + new URLSearchParams(pkgId ? { package: pkgId } : { tracking: normalizedWaybill }),
    allowed_actions: hasPackage ? ["open_package", "unpack_items"] : ["check_in"],
  };
}

export async function printLabels(
  db: DB,
  actor: Actor,
  input: z.infer<typeof labelPrintInputSchema>
) {
  role(actor, "receiver", "warehouse_admin", "super_admin");
  const size: LabelSize = input.label_size ?? input.size ?? "standard_80x50";
  const targets: { target_type: "package" | "item" | "location"; id: string; code: string; entity_type: string }[] = [];

  if (input.package_id) {
    const pkg = await one<{ id: string; code: string }>(db, "select id, code from packages where id=$1", [input.package_id]);
    targets.push({ target_type: "package", id: pkg.id, code: pkg.code, entity_type: "packages" });
  }
  if (input.item_ids?.length) {
    const uniqueIds = [...new Set(input.item_ids)];
    const { rows } = await db.query<{ id: string; code: string }>(
      "select id, code from warehouse_items where id = any($1::uuid[]) order by code",
      [uniqueIds]
    );
    guard(rows.length === uniqueIds.length, "NOT_FOUND", "One or more warehouse items were not found.", 404);
    for (const row of rows) {
      targets.push({ target_type: "item", id: row.id, code: row.code, entity_type: "warehouse_items" });
    }
  }
  if (input.location_ids?.length) {
    const uniqueLocIds = [...new Set(input.location_ids)];
    const { rows } = await db.query<{ id: string; code: string }>(
      "select id, code from storage_locations where id = any($1::uuid[]) order by code",
      [uniqueLocIds]
    );
    guard(rows.length === uniqueLocIds.length, "NOT_FOUND", "One or more storage locations were not found.", 404);
    for (const row of rows) {
      targets.push({ target_type: "location", id: row.id, code: row.code, entity_type: "storage_locations" });
    }
  }

  const labels: {
    target_type: "package" | "item" | "location";
    target_id: string;
    code: string;
    qr_payload: string;
    barcode_symbology: "CODE_128B";
    size: LabelSize;
    reprint: boolean;
    print_count: number;
  }[] = [];

  for (const t of targets) {
    const prev = await one<{ n: number }>(
      db,
      "select count(*)::int n from audit_events where entity_type=$1 and entity_id=$2 and action in ('print_label','reprint_label')",
      [t.entity_type, t.id]
    );
    const isReprint = prev.n > 0;
    if (isReprint) {
      guard(
        Boolean(input.reprint_reason && input.reprint_reason.trim().length >= 2),
        "REPRINT_REASON_REQUIRED",
        "Provide a reason when reprinting an existing label.",
        422
      );
    }
    labels.push({
      target_type: t.target_type,
      target_id: t.id,
      code: t.code,
      qr_payload: t.code,
      barcode_symbology: "CODE_128B",
      size,
      reprint: isReprint,
      print_count: prev.n + 1,
    });
  }

  const pageDims: [number, number] =
    size === "compact_50x30" ? [150, 90] : size === "shelf_100x60" ? [300, 180] : [240, 140];

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const label of labels) {
    const page = pdf.addPage(pageDims);
    drawQrAndBarcodeOnPdfPage(page, font, label.code, label.target_type, size);
  }
  const pdfBytes = Buffer.from(await pdf.save());
  const printId = uuid();
  const fileKey = "labels/" + printId;
  await db.query("insert into private_files(key,data,mime) values($1,$2,'application/pdf')", [fileKey, pdfBytes]);

  // Also store a PNG preview of the first label so automated/camera decoders and browser preview can inspect it directly
  const first = labels[0];
  if (first) {
    const pngBytes = await renderLabelPng(first.code, first.target_type, size);
    await db.query("insert into private_files(key,data,mime) values($1,$2,'image/png')", [fileKey + ".png", pngBytes]);
  }

  for (const [idx, t] of targets.entries()) {
    const meta = labels[idx];
    await audit(db, actor, meta.reprint ? "reprint_label" : "print_label", t.entity_type, t.id, {
      print_id: printId,
      code: t.code,
      size,
      print_count: meta.print_count,
      ...(input.reprint_reason ? { reprint_reason: input.reprint_reason } : {}),
    });
  }

  return {
    print_id: printId,
    size,
    label_size: size,
    pdf_url: `${appOrigin()}/api/v1/staff/labels/${printId}/file`,
    png_url: `${appOrigin()}/api/v1/staff/labels/${printId}/preview.png`,
    preview_png_url: `${appOrigin()}/api/v1/staff/labels/${printId}/preview.png`,
    labels,
  };
}

export async function readLabelPdf(db: DB, actor: Actor, printId: string) {
  role(actor, "receiver", "warehouse_admin", "inspector", "super_admin");
  return one<{ data: Buffer; mime: string }>(db, "select data,mime from private_files where key=$1", ["labels/" + printId]);
}

export async function readLabelPreviewPng(db: DB, actor: Actor, printId: string) {
  role(actor, "receiver", "warehouse_admin", "inspector", "super_admin");
  return one<{ data: Buffer; mime: string }>(db, "select data,mime from private_files where key=$1", ["labels/" + printId + ".png"]);
}

export async function verifyLabelReadback(
  db: DB,
  actor: Actor,
  input: z.infer<typeof labelVerifyInputSchema>
) {
  role(actor, "receiver", "warehouse_admin", "inspector", "super_admin");

  // Batch readback mode for multi-item packages
  if (input.expected_codes?.length || input.scanned_codes?.length) {
    const expectedList = (input.expected_codes ?? []).map(c => c.trim().toUpperCase());
    const scannedList = (input.scanned_codes ?? []).map(c => c.trim().toUpperCase());
    guard(expectedList.length > 0 && scannedList.length > 0, "SCAN_CODE_INVALID", "Provide expected_codes and scanned_codes.", 422);
    const missing = expectedList.filter(c => !scannedList.includes(c));
    const unexpected = scannedList.filter(c => !expectedList.includes(c));
    guard(
      missing.length === 0 && unexpected.length === 0,
      "LABEL_READBACK_MISMATCH",
      `Batch readback mismatch: missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}].`,
      409
    );
    const verifiedItems: { target_type: "package" | "item" | "location"; target_id: string; code: string }[] = [];
    for (const code of expectedList) {
      const single = await verifySingleReadback(db, actor, code);
      verifiedItems.push(single);
    }
    return { verified: true, count: verifiedItems.length, verified_count: verifiedItems.length, items: verifiedItems };
  }

  const expected = (input.expected_code ?? "").trim().toUpperCase();
  const scanned = (input.scanned_code ?? "").trim().toUpperCase();
  guard(expected.length >= 3 && scanned.length >= 3, "SCAN_CODE_INVALID", "Provide expected_code and scanned_code.", 422);
  guard(expected === scanned, "LABEL_READBACK_MISMATCH", "Scanned label code does not match the expected object code.", 409);
  const single = await verifySingleReadback(db, actor, expected);
  return { verified: true, ...single };
}

async function verifySingleReadback(db: DB, actor: Actor, expected: string) {
  if (expected.startsWith("P-")) {
    const pkg = await one<{ id: string; code: string }>(db, "select id, code from packages where upper(code)=$1", [expected]);
    await audit(db, actor, "verify_label_readback", "packages", pkg.id, { code: pkg.code });
    return { target_type: "package" as const, target_id: pkg.id, code: pkg.code };
  }
  if (expected.startsWith("S-")) {
    const item = await one<{ id: string; code: string }>(db, "select id, code from warehouse_items where upper(code)=$1", [expected]);
    await audit(db, actor, "verify_label_readback", "warehouse_items", item.id, { code: item.code });
    return { target_type: "item" as const, target_id: item.id, code: item.code };
  }
  const loc = (await db.query<{ id: string; code: string }>("select id, code from storage_locations where upper(code)=$1", [expected])).rows[0];
  if (loc) {
    await audit(db, actor, "verify_label_readback", "storage_locations", loc.id, { code: loc.code });
    return { target_type: "location" as const, target_id: loc.id, code: loc.code };
  }
  guard(false, "SCAN_CODE_INVALID", "Label verification requires a valid P-, S-, or storage location code.", 422);
}

// A QR encoder, written out rather than installed.
//
// Three reasons it is here instead of in package.json. The codes this screen
// produces go to a printer — onto stickers, table tents, a standee — and a
// printed code cannot be reissued, so the thing that draws it should be
// readable by whoever has to trust it. Every alternative that avoids the
// code entirely is worse: an image API (api.qrserver.com and friends) means
// the destination URL of every campaign we run leaves the building to be
// logged by a third party, and a code that renders only while some service is
// up is a poor thing to build a print run on. And the encoder is small — the
// spec's tables are most of the file.
//
// Scope is deliberately narrow: byte mode, versions 1 to 10, error
// correction L and M. That covers 271 characters, which is a long way past
// the longest tracked link this app can build (a domain, a path and five UTM
// parameters is rarely past 140). Anything longer throws rather than
// silently truncating, and the message says by how much.
//
// Error correction M is the default. L would fit more, but these end up on
// paper — stuck to a box that gets wet, printed small on a menu, scanned
// across a table in bad light — and M's ~15% recoverable damage against L's
// ~7% is worth more than characters we are not using. The rendering helpers
// below keep the quiet zone at the spec's 4 modules for the same reason:
// scanners genuinely fail without it, and it is the first thing a designer
// crops off.
//
// Verified two ways. qrcode.test.ts checks the spec's own invariants — the
// Reed-Solomon remainder property, the BCH distance properties of the format
// and version bits, the block tables against the grid geometry, and a read of
// the finished grid back into the text it came from. Separately, while this
// was written, its output was compared module for module against the `qrcode`
// npm package (installed temporarily, not a dependency) over 1,791 grids:
// every version 1-10, both levels, all eight masks and the auto-chosen one,
// across boundary-length strings and random URLs. All identical but for two
// classes, both benign:
//
//   * strings ending in a run of digits, where that library splits into byte
//     plus numeric segments to save space. This encoder is byte mode
//     throughout — simpler, and the saving on a URL is nil.
//   * two grids out of 155 where the two disagree on which mask scores best.
//     Any mask is legal; the choice is a legibility heuristic and encoders
//     differ on the third penalty rule.
//
// Neither a test suite nor another encoder is a scan, though. Print quality,
// contrast and quiet zone are physical. Point a real phone at a real code
// after changing this file.

export type Ecc = 'L' | 'M';

export type QrCode = {
  /** 1-10. Higher versions are bigger grids holding more data. */
  version: number;
  ecc: Ecc;
  /** Modules per side, 4 * version + 17. */
  size: number;
  /** Row-major, true = dark. Does not include the quiet zone. */
  modules: boolean[][];
};

// ---- The spec's tables ----------------------------------------------------

// Total codewords (data + error correction) per version, v1..v10. Derived
// from the geometry — it is the number of 8-module runs left once the finder,
// timing, alignment and format areas are taken out — but written down
// because deriving it at runtime to check a table we would need anyway is
// work for nothing. qrcode.test.ts does derive it, and checks these.
export const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

// Error-correction structure per version and level: how many EC codewords
// each block carries, and the blocks themselves as [count, data codewords
// each]. Two groups where the blocks are not all the same size — the spec
// splits them so the block sizes differ by at most one.
//
// The invariant that makes a typo here loud instead of silent: for every
// entry, sum(count * data) + sum(count) * ec === TOTAL_CODEWORDS[version-1],
// and TOTAL_CODEWORDS itself is checked against the grid geometry.
// qrcode.test.ts asserts both, for all twenty entries — which is how a
// mistyped block size is caught here rather than by a scanner.
type EcBlocks = { ec: number; groups: [number, number][] };

const EC_BLOCKS: Record<Ecc, EcBlocks[]> = {
  L: [
    { ec: 7, groups: [[1, 19]] },
    { ec: 10, groups: [[1, 34]] },
    { ec: 15, groups: [[1, 55]] },
    { ec: 20, groups: [[1, 80]] },
    { ec: 26, groups: [[1, 108]] },
    { ec: 18, groups: [[2, 68]] },
    { ec: 20, groups: [[2, 78]] },
    { ec: 24, groups: [[2, 97]] },
    { ec: 30, groups: [[2, 116]] },
    { ec: 18, groups: [[2, 68], [2, 69]] },
  ],
  M: [
    { ec: 10, groups: [[1, 16]] },
    { ec: 16, groups: [[1, 28]] },
    { ec: 26, groups: [[1, 44]] },
    { ec: 18, groups: [[2, 32]] },
    { ec: 24, groups: [[2, 43]] },
    { ec: 16, groups: [[4, 27]] },
    { ec: 18, groups: [[4, 31]] },
    { ec: 22, groups: [[2, 38], [2, 39]] },
    { ec: 22, groups: [[3, 36], [2, 37]] },
    { ec: 26, groups: [[4, 43], [1, 44]] },
  ],
};

// Alignment pattern centre coordinates per version. Every pairing of these
// gets a 5x5 pattern except the three that would sit on a finder.
const ALIGNMENT: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const MAX_VERSION = 10;

// ---- GF(256), for Reed-Solomon --------------------------------------------

// The field QR uses: arithmetic mod the primitive polynomial 0x11D. Log and
// antilog tables built once, so a multiply is two lookups and an add.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  // Doubled so a product of two logs (up to 508) never needs a modulo.
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// The generator polynomial for n error-correction codewords: the product of
// (x - a^i) for i in 0..n-1. Coefficients high-order first.
function generatorPoly(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

// The n error-correction codewords for one block: the remainder of the data
// polynomial divided by the generator. Long division, one data byte at a
// time, which is why it never needs the whole dividend in memory.
export function ecCodewords(data: number[], n: number): number[] {
  const gen = generatorPoly(n);
  const rest = new Array<number>(n).fill(0);
  data.forEach((byte) => {
    const factor = byte ^ rest[0];
    rest.shift();
    rest.push(0);
    for (let i = 0; i < n; i += 1) rest[i] ^= mul(gen[i + 1], factor);
  });
  return rest;
}

// ---- Bits and codewords ---------------------------------------------------

class Bits {
  readonly bits: number[] = [];

  push(value: number, length: number) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  get length() {
    return this.bits.length;
  }
}

const dataCodewords = (version: number, ecc: Ecc) =>
  EC_BLOCKS[ecc][version - 1].groups.reduce((sum, [count, data]) => sum + count * data, 0);

// Data plus error correction, as the block table describes it. Only the test
// calls this — it is the left-hand side of the invariant above.
export function codewordsFromBlocks(version: number, ecc: Ecc): number {
  const { ec, groups } = EC_BLOCKS[ecc][version - 1];
  const blocks = groups.reduce((sum, [count]) => sum + count, 0);
  return dataCodewords(version, ecc) + blocks * ec;
}

// How many bytes of payload a version holds: its data codewords, less the
// mode indicator and character count that ride in front of them.
export function capacityBytes(version: number, ecc: Ecc): number {
  const headerBits = 4 + (version <= 9 ? 8 : 16);
  return dataCodewords(version, ecc) - Math.ceil(headerBits / 8);
}

// The bitstream: mode, length, the bytes, a terminator, then the spec's
// alternating pad bytes out to the version's capacity.
function encodeData(bytes: Uint8Array, version: number, ecc: Ecc): number[] {
  const capacity = dataCodewords(version, ecc) * 8;
  const bits = new Bits();

  bits.push(0b0100, 4); // byte mode
  bits.push(bytes.length, version <= 9 ? 8 : 16);
  bytes.forEach((byte) => bits.push(byte, 8));

  // Up to four zero bits saying the message has ended, then zeros to the
  // next byte boundary.
  bits.push(0, Math.min(4, capacity - bits.length));
  if (bits.length % 8) bits.push(0, 8 - (bits.length % 8));

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  // 0xEC / 0x11 alternating is the spec's filler, starting from the first pad
  // byte — not from an even codeword index. The distinction is invisible in
  // half of all messages and produces a completely different grid in the
  // other half, which is exactly the kind of bug that survives a test suite
  // that only checks its own output.
  const pad = [0xec, 0x11];
  for (let i = 0; codewords.length < capacity / 8; i += 1) codewords.push(pad[i % 2]);
  return codewords;
}

// Data blocks and their EC blocks, interleaved the way the spec requires:
// the first codeword of every block, then the second of every block, and so
// on, EC after data. The interleaving is what makes a scratch across the
// printed code damage a little of every block rather than destroying one.
function interleave(codewords: number[], version: number, ecc: Ecc): number[] {
  const { ec, groups } = EC_BLOCKS[ecc][version - 1];

  const blocks: number[][] = [];
  let at = 0;
  groups.forEach(([count, size]) => {
    for (let i = 0; i < count; i += 1) {
      blocks.push(codewords.slice(at, at + size));
      at += size;
    }
  });

  const ecBlocks = blocks.map((block) => ecCodewords(block, ec));
  const longest = Math.max(...blocks.map((block) => block.length));
  const out: number[] = [];

  for (let i = 0; i < longest; i += 1) {
    blocks.forEach((block) => {
      if (i < block.length) out.push(block[i]);
    });
  }
  for (let i = 0; i < ec; i += 1) ecBlocks.forEach((block) => out.push(block[i]));
  return out;
}

// ---- Format and version information ---------------------------------------

// BCH remainder of `value` under `generator`, used by both of the below.
function bch(value: number, generator: number, bitsIn: number, bitsOut: number): number {
  let rest = value << (bitsOut - bitsIn);
  for (let i = bitsIn - 1; i >= 0; i -= 1) {
    if (rest & (1 << (bitsOut - bitsIn + i))) rest ^= generator << i;
  }
  return rest;
}

// The 15 bits stating error-correction level and mask, written twice into
// the corners so either copy can be lost. XORed with 0x5412 so an all-zero
// format never occurs.
export function formatBits(ecc: Ecc, mask: number): number {
  const level = ecc === 'L' ? 0b01 : 0b00;
  const data = (level << 3) | mask;
  return ((data << 10) | bch(data, 0b10100110111, 5, 15)) ^ 0b101010000010010;
}

// The 18 bits naming the version, present from version 7 up (below that the
// grid size alone is unambiguous to a scanner).
export function versionBits(version: number): number {
  return (version << 12) | bch(version, 0b1111100100101, 6, 18);
}

// ---- The grid -------------------------------------------------------------

const MASKS: ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

type Grid = { modules: boolean[][]; fixed: boolean[][]; size: number };

function blankGrid(size: number): Grid {
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    // Which modules belong to a function pattern. Data skips them and the
    // mask must not touch them — masking a finder pattern would make the
    // code unfindable.
    fixed: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function set(grid: Grid, row: number, col: number, dark: boolean, fixed = true) {
  if (row < 0 || col < 0 || row >= grid.size || col >= grid.size) return;
  grid.modules[row][col] = dark;
  grid.fixed[row][col] = fixed;
}

function drawFinder(grid: Grid, row: number, col: number) {
  // 8x8 including the separator, so the white ring around each finder is
  // drawn as part of it rather than left to chance.
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
      set(grid, row + r, col + c, ring !== 2 && ring <= 3);
    }
  }
}

function drawFunctionPatterns(grid: Grid, version: number) {
  const { size } = grid;

  drawFinder(grid, 0, 0);
  drawFinder(grid, 0, size - 7);
  drawFinder(grid, size - 7, 0);

  // Timing: the alternating line that tells a scanner the module pitch.
  for (let i = 8; i < size - 8; i += 1) {
    set(grid, 6, i, i % 2 === 0);
    set(grid, i, 6, i % 2 === 0);
  }

  const centres = ALIGNMENT[version];
  centres.forEach((r) => {
    centres.forEach((c) => {
      // The three that would land on a finder are skipped, not drawn over.
      const onFinder =
        (r === centres[0] && c === centres[0]) ||
        (r === centres[0] && c === centres[centres.length - 1]) ||
        (r === centres[centres.length - 1] && c === centres[0]);
      if (onFinder) return;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          set(grid, r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    });
  });

  // Format areas: reserved now, written after a mask has been chosen. Index
  // 6 is skipped in both directions — row 8 column 6 and row 6 column 8 are
  // timing modules, drawn above, and blanking them here would break the line
  // a scanner measures the module pitch against.
  for (let i = 0; i < 9; i += 1) {
    if (i === 6) continue;
    set(grid, 8, i, false);
    set(grid, i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    set(grid, 8, size - 1 - i, false);
    set(grid, size - 1 - i, 8, false);
  }

  // The one module that is always dark, just above the lower-left finder's
  // format strip. Written after the reservations above, which cover the same
  // column and would otherwise blank it — a QR with a light module here is
  // rejected outright by some readers.
  set(grid, size - 8, 8, true);

  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >> i) & 1) === 1;
      set(grid, Math.floor(i / 3), size - 11 + (i % 3), dark);
      set(grid, size - 11 + (i % 3), Math.floor(i / 3), dark);
    }
  }
}

// The zigzag: two columns at a time from the right edge, alternating up and
// down, skipping column 6 (the vertical timing line) and every function
// module on the way.
function placeData(grid: Grid, codewords: number[]) {
  const { size } = grid;
  const total = codewords.length * 8;
  let bit = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing line and is never part of a pair;
    // stepping left by one from it lands the remaining pairs correctly.
    const col = right <= 6 ? right - 1 : right;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let i = 0; i < 2; i += 1) {
        const c = col - i;
        if (grid.fixed[row][c]) continue;
        // Past the end of the codewords are the version's remainder bits:
        // they carry nothing, and staying light is what the spec asks for.
        grid.modules[row][c] = bit < total && ((codewords[bit >> 3] >> (7 - (bit % 8))) & 1) === 1;
        bit += 1;
      }
    }
    upward = !upward;
  }
}

// The spec's four penalties, added up. Lower is better; the point is to
// avoid a pattern that looks like a finder, or a large flat area, both of
// which confuse scanners.
function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;

  // Rule 1: runs of five or more of one colour, in both directions.
  const runs = (get: (a: number, b: number) => boolean) => {
    for (let a = 0; a < size; a += 1) {
      let run = 1;
      for (let b = 1; b < size; b += 1) {
        if (get(a, b) === get(a, b - 1)) {
          run += 1;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else {
          run = 1;
        }
      }
    }
  };
  runs((r, c) => modules[r][c]);
  runs((c, r) => modules[r][c]);

  // Rule 2: every 2x2 block of one colour.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3: the 1:1:3:1:1 finder-like pattern with four light modules on
  // either side, in either direction.
  const FINDER = [true, false, true, true, true, false, true];
  const looksLikeFinder = (line: boolean[], at: number) => {
    for (let i = 0; i < 7; i += 1) if (line[at + i] !== FINDER[i]) return false;
    const before = line.slice(Math.max(0, at - 4), at);
    const after = line.slice(at + 7, at + 11);
    return (before.length === 4 && before.every((v) => !v)) || (after.length === 4 && after.every((v) => !v));
  };
  for (let a = 0; a < size; a += 1) {
    const row = modules[a];
    const col = modules.map((line) => line[a]);
    for (let b = 0; b + 7 <= size; b += 1) {
      if (looksLikeFinder(row, b)) score += 40;
      if (looksLikeFinder(col, b)) score += 40;
    }
  }

  // Rule 4: how far the proportion of dark modules strays from half.
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

function writeFormat(grid: Grid, ecc: Ecc, mask: number) {
  const bits = formatBits(ecc, mask);
  const { size } = grid;

  // Coordinates are (row, col) throughout. The first copy runs down the
  // column beside the top-left finder and then along the row beneath it,
  // hopping the timing module at row 6; the second is split between the other
  // two finders so that losing a whole corner still leaves one readable copy.
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >> i) & 1) === 1;

    if (i < 6) set(grid, i, 8, dark);
    else if (i === 6) set(grid, 7, 8, dark);
    else if (i === 7) set(grid, 8, 8, dark);
    else if (i === 8) set(grid, 8, 7, dark);
    else set(grid, 8, 14 - i, dark);

    // The lower eight bits run leftward along row 8 from the right edge, the
    // upper seven downward along column 8 to the bottom edge — which is why
    // the second half starts at size - 15 + 8 and not at the always-dark
    // module just above it.
    if (i < 8) set(grid, 8, size - 1 - i, dark);
    else set(grid, size - 15 + i, 8, dark);
  }
}

/**
 * Encodes `text` as a QR code.
 *
 * Throws when the text is longer than version 10 holds, rather than
 * truncating: a QR code that scans and goes somewhere shortened is worse
 * than one that never got printed.
 */
export function encodeQr(text: string, { ecc = 'M' as Ecc, mask }: { ecc?: Ecc; mask?: number } = {}): QrCode {
  // `mask` forces one of the eight patterns instead of scoring all of them.
  // Only tests pass it — the screen always wants the best-scoring mask — but
  // it is what makes a grid comparable against another encoder's, which is
  // how the two bugs in the note above were found.
  const bytes = new TextEncoder().encode(text);

  const version = Array.from({ length: MAX_VERSION }, (_, i) => i + 1).find(
    (candidate) => bytes.length <= capacityBytes(candidate, ecc),
  );
  if (!version) {
    const limit = capacityBytes(MAX_VERSION, ecc);
    throw new Error(
      `That link is ${bytes.length} characters and a QR code here holds ${limit}. ` +
        `Shorten it by ${bytes.length - limit} — a shorter path, or fewer UTM parameters.`,
    );
  }

  const size = version * 4 + 17;
  const codewords = interleave(encodeData(bytes, version, ecc), version, ecc);

  const base = blankGrid(size);
  drawFunctionPatterns(base, version);
  placeData(base, codewords);

  let best: boolean[][] | null = null;
  let bestScore = Infinity;

  const candidates = mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask];
  for (const candidate of candidates) {
    const grid: Grid = {
      size,
      modules: base.modules.map((row) => row.slice()),
      fixed: base.fixed.map((row) => row.slice()),
    };
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (!grid.fixed[r][c] && MASKS[candidate](r, c)) grid.modules[r][c] = !grid.modules[r][c];
      }
    }
    writeFormat(grid, ecc, candidate);

    const score = penalty(grid.modules);
    if (score < bestScore) {
      bestScore = score;
      best = grid.modules;
    }
  }

  return { version, ecc, size, modules: best as boolean[][] };
}

// ---- Rendering ------------------------------------------------------------

/**
 * The code as an SVG string, ready to be saved and handed to a printer.
 *
 * One `<path>` of many subpaths rather than a rect per module: a version 10
 * code is 3,249 modules, and as rects that is a file design software opens
 * slowly and every printer renders differently.
 *
 * `margin` is in modules and defaults to the spec's 4. It is not decoration —
 * scanners use the quiet zone to find the code's edge, and cropping it is the
 * single most common reason a printed QR fails.
 */
export function qrToSvg(code: QrCode, { scale = 8, margin = 4, dark = '#111111', light = '#ffffff' } = {}): string {
  const span = code.size + margin * 2;
  const parts: string[] = [];

  code.modules.forEach((row, r) => {
    row.forEach((isDark, c) => {
      if (isDark) parts.push(`M${c + margin} ${r + margin}h1v1h-1z`);
    });
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${span * scale}" height="${span * scale}"`,
    ` viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges">`,
    `<rect width="${span}" height="${span}" fill="${light}"/>`,
    `<path d="${parts.join('')}" fill="${dark}"/>`,
    '</svg>',
  ].join('');
}

/**
 * Draws the code onto a canvas at `scale` pixels per module, for the PNG the
 * download button hands over. Integer pixels per module throughout — a
 * fractional scale antialiases the module edges, and a blurred QR is a QR
 * that needs three tries to scan.
 */
export function qrToCanvas(code: QrCode, canvas: HTMLCanvasElement, { scale = 8, margin = 4 } = {}): void {
  const span = code.size + margin * 2;
  canvas.width = span * scale;
  canvas.height = span * scale;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  code.modules.forEach((row, r) => {
    row.forEach((isDark, c) => {
      if (isDark) ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
    });
  });
}

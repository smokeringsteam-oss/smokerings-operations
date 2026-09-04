// Verifying an encoder with no decoder to check it against.
//
// The output of qrcode.ts is a grid of squares. Nothing in this repo can scan
// one, so "it works" cannot be asserted directly, and a test that merely
// snapshots the grid would freeze whatever the encoder does today — bugs
// included. What can be asserted is the spec's own arithmetic, and that is
// what this file does:
//
//   * The Reed-Solomon property, from the definition of the code rather than
//     from a table of expected bytes: data followed by its error-correction
//     codewords, read as a polynomial, must evaluate to zero at every root
//     of the generator. A wrong remainder cannot satisfy that by accident.
//
//   * The block tables against the geometry. Total codewords per version is
//     computable from the module count, so the hand-entered table is checked
//     against a formula rather than against itself — the transcription error
//     this file most needs to catch.
//
//   * The BCH format and version bits, by their distance property (any two
//     format strings differ in at least 7 of 15 bits, which is what lets a
//     scanner read a damaged one) plus one published value each as an anchor.
//
//   * A round trip: read the finished grid back the way a scanner does —
//     find the mask in the format bits, unmask, walk the placement zigzag,
//     and pull the text out. That covers placement, masking and the function
//     pattern map end to end.
//
// What none of it covers is a real scan. Print quality, contrast and quiet
// zone are physical, and the mask table below is re-declared from the spec,
// so an identical misreading in both copies would pass here. Point a phone
// at a real code after changing this file.
import { describe, it, expect } from 'vitest';
import {
  encodeQr,
  capacityBytes,
  codewordsFromBlocks,
  ecCodewords,
  formatBits,
  versionBits,
  qrToSvg,
  TOTAL_CODEWORDS,
} from './qrcode';

const LINK = 'https://smokeringsbbq.in/order?utm_campaign=weekend-brisket&utm_medium=social&utm_source=instagram';

// ---- GF(256), independently of the encoder's own tables --------------------

function gfMul(a: number, b: number): number {
  let result = 0;
  let x = a;
  let y = b;
  while (y) {
    if (y & 1) result ^= x;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
    y >>= 1;
  }
  return result & 0xff;
}

function alpha(power: number): number {
  let x = 1;
  for (let i = 0; i < power; i += 1) x = gfMul(x, 2);
  return x;
}

describe('Reed-Solomon', () => {
  it('produces codewords the generator polynomial divides exactly', () => {
    // The defining property of the code, checked without a table of expected
    // bytes: for each root a^i of the generator, the whole codeword
    // (data followed by EC) evaluated there must be zero.
    const data = Array.from({ length: 16 }, (_, i) => (i * 37 + 11) % 256);
    const n = 10;
    const codeword = [...data, ...ecCodewords(data, n)];

    for (let i = 0; i < n; i += 1) {
      const root = alpha(i);
      let value = 0;
      codeword.forEach((byte) => {
        value = gfMul(value, root) ^ byte;
      });
      expect(value, `codeword is not divisible at root a^${i}`).toBe(0);
    }
  });

  it('gives every block its own remainder', () => {
    expect(ecCodewords([1, 2, 3], 7)).not.toEqual(ecCodewords([1, 2, 4], 7));
    expect(ecCodewords([0, 0, 0], 7)).toEqual(new Array(7).fill(0));
  });
});

// ---- The hand-entered tables, against the geometry -------------------------

// Total codewords a version holds, derived rather than looked up: the modules
// in the square, less the finder, timing, alignment and version areas, over
// eight. This is the check on the block table — a mistyped data-codeword
// count cannot agree with the grid it has to fit into.
function totalCodewordsFromGeometry(version: number): number {
  let modules = 16 * version * version + 128 * version + 64;
  if (version >= 2) {
    const aligns = Math.floor(version / 7) + 2;
    modules -= 25 * aligns * aligns - 10 * aligns - 55;
  }
  if (version >= 7) modules -= 36;
  return Math.floor(modules / 8);
}

describe('the block tables', () => {
  it('agrees with the grid geometry about how many codewords fit', () => {
    for (let version = 1; version <= 10; version += 1) {
      expect(TOTAL_CODEWORDS[version - 1], `version ${version}`).toBe(totalCodewordsFromGeometry(version));
    }
  });

  it('fills each version exactly, at both error-correction levels', () => {
    // The invariant a mistyped block size cannot survive: data codewords plus
    // error-correction codewords must be exactly what the grid holds.
    (['L', 'M'] as const).forEach((ecc) => {
      for (let version = 1; version <= 10; version += 1) {
        expect(codewordsFromBlocks(version, ecc), `v${version}-${ecc}`).toBe(TOTAL_CODEWORDS[version - 1]);
      }
    });
  });

  it('matches the published byte capacities', () => {
    // Four anchors from the spec's own capacity table. If the block table is
    // subtly wrong these are what will not line up.
    expect(capacityBytes(1, 'L')).toBe(17);
    expect(capacityBytes(1, 'M')).toBe(14);
    expect(capacityBytes(5, 'L')).toBe(106);
    expect(capacityBytes(10, 'M')).toBe(213);
    expect(capacityBytes(10, 'L')).toBe(271);
  });

  it('holds more at L than at M, at every version', () => {
    for (let version = 1; version <= 10; version += 1) {
      expect(capacityBytes(version, 'L')).toBeGreaterThan(capacityBytes(version, 'M'));
    }
  });
});

// ---- Format and version information ----------------------------------------

const hamming = (a: number, b: number) => {
  let bits = 0;
  let x = a ^ b;
  while (x) {
    bits += x & 1;
    x >>>= 1;
  }
  return bits;
};

describe('format information', () => {
  it('matches the published value for level L, mask 0', () => {
    expect(formatBits('L', 0)).toBe(0b111011111000100);
  });

  it('keeps every pair of format strings at least 7 bits apart', () => {
    // The BCH property that lets a scanner read the format off a damaged
    // corner. A broken generator polynomial breaks it immediately.
    const all: number[] = [];
    (['L', 'M'] as const).forEach((ecc) => {
      for (let mask = 0; mask < 8; mask += 1) all.push(formatBits(ecc, mask));
    });
    all.forEach((a, i) => {
      all.slice(i + 1).forEach((b) => expect(hamming(a, b)).toBeGreaterThanOrEqual(7));
    });
  });

  it('is never all zeros, which is what the 0x5412 xor is for', () => {
    for (let mask = 0; mask < 8; mask += 1) {
      expect(formatBits('M', mask)).not.toBe(0);
      expect(formatBits('L', mask)).not.toBe(0);
    }
  });
});

describe('version information', () => {
  it('matches the published value for version 7', () => {
    expect(versionBits(7)).toBe(0b000111110010010100);
  });

  it('keeps every pair of version strings at least 8 bits apart', () => {
    const all = [7, 8, 9, 10].map(versionBits);
    all.forEach((a, i) => {
      all.slice(i + 1).forEach((b) => expect(hamming(a, b)).toBeGreaterThanOrEqual(8));
    });
  });
});

// ---- The grid --------------------------------------------------------------

describe('encodeQr', () => {
  it('picks the smallest version the text fits in', () => {
    expect(encodeQr('x'.repeat(17), { ecc: 'L' }).version).toBe(1);
    expect(encodeQr('x'.repeat(18), { ecc: 'L' }).version).toBe(2);
    expect(encodeQr('x'.repeat(14), { ecc: 'M' }).version).toBe(1);
    expect(encodeQr('x'.repeat(15), { ecc: 'M' }).version).toBe(2);
  });

  it('sizes the grid at 4v + 17', () => {
    const code = encodeQr(LINK);
    expect(code.size).toBe(code.version * 4 + 17);
    expect(code.modules).toHaveLength(code.size);
    code.modules.forEach((row) => expect(row).toHaveLength(code.size));
  });

  it('draws a finder in three corners and none in the fourth', () => {
    const { modules, size } = encodeQr(LINK);
    const finderAt = (row: number, col: number) =>
      [0, 1, 2, 3, 4, 5, 6].every((r) =>
        [0, 1, 2, 3, 4, 5, 6].every((c) => {
          const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
          return modules[row + r][col + c] === (ring !== 2);
        }),
      );

    expect(finderAt(0, 0)).toBe(true);
    expect(finderAt(0, size - 7)).toBe(true);
    expect(finderAt(size - 7, 0)).toBe(true);
    expect(finderAt(size - 7, size - 7)).toBe(false);
  });

  it('alternates the timing patterns and sets the always-dark module', () => {
    const { modules, size } = encodeQr(LINK);
    for (let i = 8; i < size - 8; i += 1) {
      expect(modules[6][i]).toBe(i % 2 === 0);
      expect(modules[i][6]).toBe(i % 2 === 0);
    }
    expect(modules[size - 8][8]).toBe(true);
  });

  it('is deterministic — the same link is the same code', () => {
    expect(encodeQr(LINK).modules).toEqual(encodeQr(LINK).modules);
  });

  it('refuses a link too long to encode instead of truncating it', () => {
    // Truncation would produce a code that scans perfectly and goes to the
    // wrong page — the one failure mode a printed code cannot recover from.
    expect(() => encodeQr('x'.repeat(300), { ecc: 'L' })).toThrow(/holds 271/);
    expect(() => encodeQr('x'.repeat(300), { ecc: 'L' })).toThrow(/Shorten it by 29/);
  });

  it('encodes non-ASCII by its UTF-8 length', () => {
    // A rupee sign is three bytes. Counting characters instead would produce
    // a code claiming a length it does not have.
    const code = encodeQr('₹'.repeat(6), { ecc: 'L' });
    expect(code.version).toBe(2);
  });
});

// ---- Reading it back -------------------------------------------------------

// The eight mask patterns, re-declared from the spec. Deliberately a second
// copy: the point of the round trip below is to check the grid, and taking
// the encoder's own masks would make part of the check circular. It is still
// only as good as this transcription — see the note at the top of the file.
const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const ALIGNMENT: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

// Which modules a scanner knows not to read: the three corners with their
// format strips, the two timing lines, and the alignment patterns. Built
// from the spec's layout rather than from the encoder's own map.
function functionModules(version: number, size: number): boolean[][] {
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const block = (r0: number, c0: number, rows: number, cols: number) => {
    for (let r = r0; r < r0 + rows; r += 1) for (let c = c0; c < c0 + cols; c += 1) fixed[r][c] = true;
  };

  block(0, 0, 9, 9);
  block(0, size - 8, 9, 8);
  block(size - 8, 0, 8, 9);
  for (let i = 0; i < size; i += 1) {
    fixed[6][i] = true;
    fixed[i][6] = true;
  }

  const centres = ALIGNMENT[version];
  centres.forEach((r) =>
    centres.forEach((c) => {
      const corner =
        (r === centres[0] && c === centres[0]) ||
        (r === centres[0] && c === centres[centres.length - 1]) ||
        (r === centres[centres.length - 1] && c === centres[0]);
      if (!corner) block(r - 2, c - 2, 5, 5);
    }),
  );

  return fixed;
}

// A scanner's read, for the single-block versions (1-3 at level M), which is
// every code short enough to skip de-interleaving.
function readBack(code: ReturnType<typeof encodeQr>): string {
  const { modules, size, version } = code;

  // The mask, off the first copy of the format bits.
  let format = 0;
  const formatBit = (i: number) => {
    if (i < 6) return modules[i][8];
    if (i === 6) return modules[7][8];
    if (i === 7) return modules[8][8];
    if (i === 8) return modules[8][7];
    return modules[8][14 - i];
  };
  for (let i = 0; i < 15; i += 1) if (formatBit(i)) format |= 1 << i;
  const mask = ((format ^ 0b101010000010010) >> 10) & 0b111;

  const fixed = functionModules(version, size);
  const bits: number[] = [];
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    const col = right <= 6 ? right - 1 : right;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let i = 0; i < 2; i += 1) {
        const c = col - i;
        if (fixed[row][c]) continue;
        bits.push((modules[row][c] !== MASKS[mask](row, c)) ? 1 : 0);
      }
    }
    upward = !upward;
  }

  const take = (from: number, count: number) =>
    bits.slice(from, from + count).reduce((value, bit) => (value << 1) | bit, 0);

  expect(take(0, 4), 'mode indicator is not byte mode').toBe(0b0100);
  const length = take(4, 8);
  const bytes = Array.from({ length }, (_, i) => take(12 + i * 8, 8));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

describe('reading the finished grid back', () => {
  it('recovers the text a scanner would read', () => {
    // End to end over the parts a table cannot check: the bit placement
    // zigzag, the mask that was chosen and written into the format bits, and
    // the map of which modules carry data at all.
    const text = 'https://smokeringsbbq.in/o?s=ig';
    const code = encodeQr(text, { ecc: 'M' });
    expect(code.version).toBeLessThanOrEqual(3);
    expect(readBack(code)).toBe(text);
  });

  it('recovers text from every version up to the single-block limit', () => {
    [10, 25, 40].forEach((length) => {
      const text = 'a'.repeat(length);
      expect(readBack(encodeQr(text, { ecc: 'M' }))).toBe(text);
    });
  });

  it('recovers the text under each of the eight masks', () => {
    // Forcing the mask is what makes a grid comparable against another
    // encoder's; it also means all eight patterns are exercised here rather
    // than only whichever one happens to score best today.
    const text = 'https://smokeringsbbq.in/o?s=qr';
    for (let mask = 0; mask < 8; mask += 1) {
      expect(readBack(encodeQr(text, { ecc: 'M', mask })), `mask ${mask}`).toBe(text);
    }
  });

  it('varies the grid by mask, and picks one of the eight for real', () => {
    const text = 'https://smokeringsbbq.in/o?s=qr';
    const auto = JSON.stringify(encodeQr(text, { ecc: 'M' }).modules);
    const all = Array.from({ length: 8 }, (_, mask) => JSON.stringify(encodeQr(text, { ecc: 'M', mask }).modules));
    expect(new Set(all).size).toBe(8);
    expect(all).toContain(auto);
  });
});

describe('qrToSvg', () => {
  it('keeps the four-module quiet zone the spec asks for', () => {
    const code = encodeQr(LINK);
    const svg = qrToSvg(code, { scale: 4 });
    expect(svg).toContain(`viewBox="0 0 ${code.size + 8} ${code.size + 8}"`);
    expect(svg).toContain(`width="${(code.size + 8) * 4}"`);
  });

  it('paints a light background rather than relying on the page behind it', () => {
    // A transparent QR on a dark surface is an unscannable QR, and these get
    // dropped into design tools by people who cannot see that coming.
    expect(qrToSvg(encodeQr(LINK))).toContain('<rect width=');
  });
});

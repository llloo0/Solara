export function md5(bytes: Uint8Array): string {
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const constants = Array.from({ length: 64 }, (_, index) =>
    Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000)
  );
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const words = new Uint32Array(16);
    for (let index = 0; index < 64; index += 1) {
      const position = offset + index;
      let value = 0;
      if (position < bytes.length) value = bytes[position];
      else if (position === bytes.length) value = 0x80;
      words[index >>> 2] |= value << ((index & 3) * 8);
    }
    if (offset === paddedLength - 64) {
      words[14] = bitLength >>> 0;
      words[15] = Math.floor(bitLength / 0x100000000) >>> 0;
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f: number;
      let wordIndex: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }
      const sum = (a + f + constants[index] + words[wordIndex]) | 0;
      const shift = shifts[index];
      const rotated = (sum << shift) | (sum >>> (32 - shift));
      [a, d, c, b] = [d, c, b, (b + rotated) | 0];
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  return [a0, b0, c0, d0]
    .map((word) => [0, 8, 16, 24]
      .map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, "0"))
      .join(""))
    .join("");
}

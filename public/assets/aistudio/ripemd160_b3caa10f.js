// RIPEMD-160 in WGSL. Single-block (≤55-byte) variant — covers the 32-byte SHA-256
// output that this hash is applied to in the Bitcoin pipeline.

export const ripemd160WGSL = /* wgsl */ `

const RM_K_L: array<u32, 5> = array<u32, 5>(
  0x00000000u, 0x5A827999u, 0x6ED9EBA1u, 0x8F1BBCDCu, 0xA953FD4Eu
);
const RM_K_R: array<u32, 5> = array<u32, 5>(
  0x50A28BE6u, 0x5C4DD124u, 0x6D703EF3u, 0x7A6D76E9u, 0x00000000u
);
const RM_R_L: array<u32, 80> = array<u32, 80>(
   0u,  1u,  2u,  3u,  4u,  5u,  6u,  7u,  8u,  9u, 10u, 11u, 12u, 13u, 14u, 15u,
   7u,  4u, 13u,  1u, 10u,  6u, 15u,  3u, 12u,  0u,  9u,  5u,  2u, 14u, 11u,  8u,
   3u, 10u, 14u,  4u,  9u, 15u,  8u,  1u,  2u,  7u,  0u,  6u, 13u, 11u,  5u, 12u,
   1u,  9u, 11u, 10u,  0u,  8u, 12u,  4u, 13u,  3u,  7u, 15u, 14u,  5u,  6u,  2u,
   4u,  0u,  5u,  9u,  7u, 12u,  2u, 10u, 14u,  1u,  3u,  8u, 11u,  6u, 15u, 13u
);
const RM_R_R: array<u32, 80> = array<u32, 80>(
   5u, 14u,  7u,  0u,  9u,  2u, 11u,  4u, 13u,  6u, 15u,  8u,  1u, 10u,  3u, 12u,
   6u, 11u,  3u,  7u,  0u, 13u,  5u, 10u, 14u, 15u,  8u, 12u,  4u,  9u,  1u,  2u,
  15u,  5u,  1u,  3u,  7u, 14u,  6u,  9u, 11u,  8u, 12u,  2u, 10u,  0u,  4u, 13u,
   8u,  6u,  4u,  1u,  3u, 11u, 15u,  0u,  5u, 12u,  2u, 13u,  9u,  7u, 10u, 14u,
  12u, 15u, 10u,  4u,  1u,  5u,  8u,  7u,  6u,  2u, 13u, 14u,  0u,  3u,  9u, 11u
);
const RM_S_L: array<u32, 80> = array<u32, 80>(
  11u, 14u, 15u, 12u,  5u,  8u,  7u,  9u, 11u, 13u, 14u, 15u,  6u,  7u,  9u,  8u,
   7u,  6u,  8u, 13u, 11u,  9u,  7u, 15u,  7u, 12u, 15u,  9u, 11u,  7u, 13u, 12u,
  11u, 13u,  6u,  7u, 14u,  9u, 13u, 15u, 14u,  8u, 13u,  6u,  5u, 12u,  7u,  5u,
  11u, 12u, 14u, 15u, 14u, 15u,  9u,  8u,  9u, 14u,  5u,  6u,  8u,  6u,  5u, 12u,
   9u, 15u,  5u, 11u,  6u,  8u, 13u, 12u,  5u, 12u, 13u, 14u, 11u,  8u,  5u,  6u
);
const RM_S_R: array<u32, 80> = array<u32, 80>(
   8u,  9u,  9u, 11u, 13u, 15u, 15u,  5u,  7u,  7u,  8u, 11u, 14u, 14u, 12u,  6u,
   9u, 13u, 15u,  7u, 12u,  8u,  9u, 11u,  7u,  7u, 12u,  7u,  6u, 15u, 13u, 11u,
   9u,  7u, 15u, 11u,  8u,  6u,  6u, 14u, 12u, 13u,  5u, 14u, 13u, 13u,  7u,  5u,
  15u,  5u,  8u, 11u, 14u, 14u,  6u, 14u,  6u,  9u, 12u,  9u, 12u,  5u, 15u,  8u,
   8u,  5u, 12u,  9u, 12u,  5u, 14u,  6u,  8u, 13u, 6u,  5u, 15u, 13u, 11u, 11u
);

fn rotl32(x: u32, n: u32) -> u32 {
  return (x << n) | (x >> (32u - n));
}

fn rmF(j: u32, x: u32, y: u32, z: u32) -> u32 {
  if (j < 16u) { return x ^ y ^ z; }
  if (j < 32u) { return (x & y) | (~x & z); }
  if (j < 48u) { return (x | ~y) ^ z; }
  if (j < 64u) { return (x & z) | (y & ~z); }
  return x ^ (y | ~z);
}

fn ripemd160_compress(state: ptr<function, array<u32, 5>>, block: ptr<function, array<u32, 16>>) {
  var A = (*state)[0]; var B = (*state)[1]; var C = (*state)[2]; var D = (*state)[3]; var E = (*state)[4];
  var Ap = (*state)[0]; var Bp = (*state)[1]; var Cp = (*state)[2]; var Dp = (*state)[3]; var Ep = (*state)[4];

  for (var j: u32 = 0u; j < 80u; j = j + 1u) {
    let round = j >> 4u;

    let T = rotl32(A + rmF(j, B, C, D) + (*block)[RM_R_L[j]] + RM_K_L[round], RM_S_L[j]) + E;
    A = E; E = D; D = rotl32(C, 10u); C = B; B = T;

    let Tp = rotl32(Ap + rmF(79u - j, Bp, Cp, Dp) + (*block)[RM_R_R[j]] + RM_K_R[round], RM_S_R[j]) + Ep;
    Ap = Ep; Ep = Dp; Dp = rotl32(Cp, 10u); Cp = Bp; Bp = Tp;
  }

  // Standard RIPEMD-160 finalization rotates state by one position:
  //   T = h1 + C + Dp; h1 = h2 + D + Ep; h2 = h3 + E + Ap; h3 = h4 + A + Bp; h4 = h0 + B + Cp; h0 = T.
  let new_h0 = (*state)[1] + C + Dp;
  let new_h1 = (*state)[2] + D + Ep;
  let new_h2 = (*state)[3] + E + Ap;
  let new_h3 = (*state)[4] + A + Bp;
  let new_h4 = (*state)[0] + B + Cp;
  (*state)[0] = new_h0;
  (*state)[1] = new_h1;
  (*state)[2] = new_h2;
  (*state)[3] = new_h3;
  (*state)[4] = new_h4;
}

// RIPEMD-160 of exactly 32 bytes: the SHA-256 digest, packed little-endian into m[0..7] by the
// caller. The padding is constant (block[8] = 0x80, block[9..13] = 0, block[14] = 256 bits,
// block[15] = 0), and the 80 rounds are written as five loops of 16 so the round function and
// the round constant are compile-time constants for each loop instead of a four-way branch and a
// table lookup per round. The message-index and shift tables are still read per round. Same
// maths as ripemd160_short(bytes, 32u), which stays for the tests.
fn ripemd160_sha32(m: array<u32, 8>) -> array<u32, 5> {
  var X: array<u32, 16>;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) { X[i] = m[i]; }
  X[8] = 0x80u;
  for (var i: u32 = 9u; i < 16u; i = i + 1u) { X[i] = 0u; }
  X[14] = 256u;

  var A = 0x67452301u; var B = 0xEFCDAB89u; var C = 0x98BADCFEu; var D = 0x10325476u; var E = 0xC3D2E1F0u;
  var Ap = A; var Bp = B; var Cp = C; var Dp = D; var Ep = E;
  var T: u32;

  // Round 1: left f1 = x ^ y ^ z, K 0; right f5 = x ^ (y | ~z), K 0x50A28BE6.
  for (var j: u32 = 0u; j < 16u; j = j + 1u) {
    T = rotl32(A + (B ^ C ^ D) + X[RM_R_L[j]], RM_S_L[j]) + E;
    A = E; E = D; D = rotl32(C, 10u); C = B; B = T;
    T = rotl32(Ap + (Bp ^ (Cp | ~Dp)) + X[RM_R_R[j]] + 0x50A28BE6u, RM_S_R[j]) + Ep;
    Ap = Ep; Ep = Dp; Dp = rotl32(Cp, 10u); Cp = Bp; Bp = T;
  }
  // Round 2: left f2 = (x & y) | (~x & z), K 0x5A827999; right f4 = (x & z) | (y & ~z), K 0x5C4DD124.
  for (var j: u32 = 16u; j < 32u; j = j + 1u) {
    T = rotl32(A + ((B & C) | (~B & D)) + X[RM_R_L[j]] + 0x5A827999u, RM_S_L[j]) + E;
    A = E; E = D; D = rotl32(C, 10u); C = B; B = T;
    T = rotl32(Ap + ((Bp & Dp) | (Cp & ~Dp)) + X[RM_R_R[j]] + 0x5C4DD124u, RM_S_R[j]) + Ep;
    Ap = Ep; Ep = Dp; Dp = rotl32(Cp, 10u); Cp = Bp; Bp = T;
  }
  // Round 3: both sides f3 = (x | ~y) ^ z; K 0x6ED9EBA1 left, 0x6D703EF3 right.
  for (var j: u32 = 32u; j < 48u; j = j + 1u) {
    T = rotl32(A + ((B | ~C) ^ D) + X[RM_R_L[j]] + 0x6ED9EBA1u, RM_S_L[j]) + E;
    A = E; E = D; D = rotl32(C, 10u); C = B; B = T;
    T = rotl32(Ap + ((Bp | ~Cp) ^ Dp) + X[RM_R_R[j]] + 0x6D703EF3u, RM_S_R[j]) + Ep;
    Ap = Ep; Ep = Dp; Dp = rotl32(Cp, 10u); Cp = Bp; Bp = T;
  }
  // Round 4: left f4, K 0x8F1BBCDC; right f2, K 0x7A6D76E9.
  for (var j: u32 = 48u; j < 64u; j = j + 1u) {
    T = rotl32(A + ((B & D) | (C & ~D)) + X[RM_R_L[j]] + 0x8F1BBCDCu, RM_S_L[j]) + E;
    A = E; E = D; D = rotl32(C, 10u); C = B; B = T;
    T = rotl32(Ap + ((Bp & Cp) | (~Bp & Dp)) + X[RM_R_R[j]] + 0x7A6D76E9u, RM_S_R[j]) + Ep;
    Ap = Ep; Ep = Dp; Dp = rotl32(Cp, 10u); Cp = Bp; Bp = T;
  }
  // Round 5: left f5, K 0xA953FD4E; right f1, K 0.
  for (var j: u32 = 64u; j < 80u; j = j + 1u) {
    T = rotl32(A + (B ^ (C | ~D)) + X[RM_R_L[j]] + 0xA953FD4Eu, RM_S_L[j]) + E;
    A = E; E = D; D = rotl32(C, 10u); C = B; B = T;
    T = rotl32(Ap + (Bp ^ Cp ^ Dp) + X[RM_R_R[j]], RM_S_R[j]) + Ep;
    Ap = Ep; Ep = Dp; Dp = rotl32(Cp, 10u); Cp = Bp; Bp = T;
  }
  return array<u32, 5>(0xEFCDAB89u + C + Dp, 0x98BADCFEu + D + Ep, 0x10325476u + E + Ap,
                       0xC3D2E1F0u + A + Bp, 0x67452301u + B + Cp);
}

// RIPEMD-160 of byte_len bytes packed into 14 LE u32 words. byte_len ≤ 55.
fn ripemd160_short(bytes: array<u32, 14>, byte_len: u32) -> array<u32, 5> {
  var block: array<u32, 16>;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) { block[i] = 0u; }

  let full_words = byte_len / 4u;
  for (var i: u32 = 0u; i < full_words; i = i + 1u) { block[i] = bytes[i]; }

  let pad_pos = byte_len % 4u;
  // Keep the low (pad_pos * 8) bits of the partial word. When pad_pos == 0 this gives 0.
  let keep_mask = (1u << (pad_pos * 8u)) - 1u;
  let kept = bytes[full_words] & keep_mask;
  let marker = 0x80u << (pad_pos * 8u);
  block[full_words] = kept | marker;

  // Length in bits, little-endian, in last 8 bytes (block[14]/[15]).
  block[14] = byte_len * 8u;
  block[15] = 0u;

  var state: array<u32, 5> = array<u32, 5>(
    0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u
  );
  ripemd160_compress(&state, &block);
  return state;
}
`;

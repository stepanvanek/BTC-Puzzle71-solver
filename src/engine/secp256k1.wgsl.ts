import { secp256k1 } from '@noble/curves/secp256k1.js';

export const WORKGROUP_SIZE = 64;
export const BATCH_HALF = 128;
export const BATCH_KEYS = 2 * BATCH_HALF + 1; // 257
export const KG_ENTRIES = BATCH_HALF + 1; // 129
export const OFFSET_TABLE_BITS = 22;
export const KEYS_PER_THREAD_DEFAULT = 514; // 2 symmetric batches of 257 keys per thread
export const MAX_HITS = 16;
export const MAX_POW_HITS = 16;

export const HEADER_BYTES = 32 + 32 + 20 + 4; // 88 bytes
export const TABLE_BYTES = OFFSET_TABLE_BITS * 64; // 1408 bytes
export const KG_TABLE_BYTES = KG_ENTRIES * 64; // 8256 bytes
export const PARAMS_BYTES = HEADER_BYTES + TABLE_BYTES + KG_TABLE_BYTES; // 9752 bytes
export const OUTPUT_BYTES = 4 + MAX_HITS * 8 + 4 + MAX_POW_HITS * 8; // 264 bytes

const bigintWGSL = /* wgsl */ `
struct U256 { limbs: array<u32, 8> };
struct U512 { limbs: array<u32, 16> };

const P_LIMBS: array<u32, 8> = array<u32, 8>(
  0xFFFFFC2Fu, 0xFFFFFFFEu, 0xFFFFFFFFu, 0xFFFFFFFFu,
  0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu
);

fn u256_zero() -> U256 {
  return U256(array<u32, 8>(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u));
}

fn u256_one() -> U256 {
  return U256(array<u32, 8>(1u, 0u, 0u, 0u, 0u, 0u, 0u, 0u));
}

fn u256_eq(a: U256, b: U256) -> bool {
  var diff: u32 = 0u;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    diff = diff | (a.limbs[i] ^ b.limbs[i]);
  }
  return diff == 0u;
}

fn u256_is_zero(a: U256) -> bool {
  var acc: u32 = 0u;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    acc = acc | a.limbs[i];
  }
  return acc == 0u;
}

fn u256_geq(a: U256, b: U256) -> u32 {
  var borrow: u32 = 0u;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let ai = a.limbs[i];
    let bi = b.limbs[i];
    let s1 = ai - bi;
    let b1 = u32(ai < bi);
    let s2 = s1 - borrow;
    let b2 = u32(s1 < borrow);
    borrow = b1 + b2;
  }
  return 1u - borrow;
}

struct AddOut { sum: U256, carry: u32 };
fn u256_add_raw(a: U256, b: U256) -> AddOut {
  var r: U256;
  var carry: u32 = 0u;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let s = a.limbs[i] + b.limbs[i];
    let c1 = u32(s < a.limbs[i]);
    let s2 = s + carry;
    let c2 = u32(s2 < s);
    r.limbs[i] = s2;
    carry = c1 + c2;
  }
  return AddOut(r, carry);
}

struct SubOut { diff: U256, borrow: u32 };
fn u256_sub_raw(a: U256, b: U256) -> SubOut {
  var r: U256;
  var borrow: u32 = 0u;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let s1 = a.limbs[i] - b.limbs[i];
    let b1 = u32(a.limbs[i] < b.limbs[i]);
    let s2 = s1 - borrow;
    let b2 = u32(s1 < borrow);
    r.limbs[i] = s2;
    borrow = b1 + b2;
  }
  return SubOut(r, borrow);
}

fn mul32(a: u32, b: u32) -> vec2<u32> {
  let ah: u32 = a >> 16u;
  let al: u32 = a & 0xFFFFu;
  let bh: u32 = b >> 16u;
  let bl: u32 = b & 0xFFFFu;
  let ll: u32 = al * bl;
  let lh: u32 = al * bh;
  let hl: u32 = ah * bl;
  let hh: u32 = ah * bh;
  let mid: u32 = (ll >> 16u) + (lh & 0xFFFFu) + (hl & 0xFFFFu);
  let lo: u32  = (ll & 0xFFFFu) | (mid << 16u);
  let hi: u32  = hh + (lh >> 16u) + (hl >> 16u) + (mid >> 16u);
  return vec2<u32>(lo, hi);
}

fn u256_mul(a: U256, b: U256) -> U512 {
  var r: U512;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) { r.limbs[i] = 0u; }
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    var carry: u32 = 0u;
    for (var j: u32 = 0u; j < 8u; j = j + 1u) {
      let prod: vec2<u32> = mul32(a.limbs[i], b.limbs[j]);
      let cur: u32 = r.limbs[i + j];
      let s1: u32 = cur + prod.x;
      let c1: u32 = u32(s1 < cur);
      let s2: u32 = s1 + carry;
      let c2: u32 = u32(s2 < s1);
      r.limbs[i + j] = s2;
      carry = prod.y + c1 + c2;
    }
    r.limbs[i + 8u] = r.limbs[i + 8u] + carry;
  }
  return r;
}

fn add3_ripple(r: ptr<function, array<u32, 8>>, t0: u32, t1: u32, t2: u32) -> u32 {
  var t: array<u32, 8> = array<u32, 8>(t0, t1, t2, 0u, 0u, 0u, 0u, 0u);
  var c: u32 = 0u;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    let cur = (*r)[i];
    let s1 = cur + t[i];
    let c1 = u32(s1 < cur);
    let s2 = s1 + c;
    let c2 = u32(s2 < s1);
    (*r)[i] = s2;
    c = c1 + c2;
  }
  return c;
}

fn mod_p(a: U512) -> U256 {
  var r: array<u32, 8>;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) { r[i] = a.limbs[i]; }
  var r8: u32 = 0u;
  var r9: u32 = 0u;

  {
    var carry: u32 = 0u;
    for (var i: u32 = 0u; i < 8u; i = i + 1u) {
      let prod = mul32(a.limbs[i + 8u], 977u);
      let s1 = r[i] + prod.x;
      let c1 = u32(s1 < r[i]);
      let s2 = s1 + carry;
      let c2 = u32(s2 < s1);
      r[i] = s2;
      carry = prod.y + c1 + c2;
    }
    r8 = carry;
  }
  {
    var carry: u32 = 0u;
    for (var i: u32 = 0u; i < 7u; i = i + 1u) {
      let dest = r[i + 1u];
      let s1 = dest + a.limbs[i + 8u];
      let c1 = u32(s1 < dest);
      let s2 = s1 + carry;
      let c2 = u32(s2 < s1);
      r[i + 1u] = s2;
      carry = c1 + c2;
    }
    let s1 = r8 + a.limbs[15];
    let c1 = u32(s1 < r8);
    let s2 = s1 + carry;
    let c2 = u32(s2 < s1);
    r8 = s2;
    r9 = c1 + c2;
  }

  let p977 = mul32(r8, 977u);
  let t0 = p977.x;
  let u1 = p977.y + r8;
  let uc = u32(u1 < p977.y);
  let t1 = u1 + r9 * 977u;
  let tc = u32(t1 < u1);
  let t2 = r9 + uc + tc;
  let c3 = add3_ripple(&r, t0, t1, t2);

  let c4 = add3_ripple(&r, c3 * 977u, c3, 0u);
  _ = add3_ripple(&r, c4 * 977u, c4, 0u);

  var out: U256;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) { out.limbs[i] = r[i]; }
  if (u256_geq(out, U256(P_LIMBS)) == 1u) {
    let s = u256_sub_raw(out, U256(P_LIMBS));
    out = s.diff;
  }
  return out;
}

fn fp_add(a: U256, b: U256) -> U256 {
  let s = u256_add_raw(a, b);
  if (s.carry == 1u || u256_geq(s.sum, U256(P_LIMBS)) == 1u) {
    let r = u256_sub_raw(s.sum, U256(P_LIMBS));
    return r.diff;
  }
  return s.sum;
}

fn fp_sub(a: U256, b: U256) -> U256 {
  let s = u256_sub_raw(a, b);
  if (s.borrow == 1u) {
    let r = u256_add_raw(s.diff, U256(P_LIMBS));
    return r.sum;
  }
  return s.diff;
}

fn fp_mul(a: U256, b: U256) -> U256 {
  let prod: U512 = u256_mul(a, b);
  return mod_p(prod);
}

fn fp_sqr(a: U256) -> U256 {
  return fp_mul(a, a);
}

fn fp_sqr_n(a: U256, n: u32) -> U256 {
  var r = a;
  for (var i: u32 = 0u; i < n; i = i + 1u) { r = fp_sqr(r); }
  return r;
}

// Table-driven Fermat inversion a^(p-2) mod p (single fp_mul & fp_sqr_n call site for high occupancy + naga safety)
fn fp_inv(a: U256) -> U256 {
  let N:  array<u32, 15> = array<u32, 15>(1u, 1u, 3u, 3u, 2u, 11u, 22u, 44u, 88u, 44u, 3u, 23u, 5u, 3u, 2u);
  let M:  array<u32, 15> = array<u32, 15>(0u, 0u, 2u, 2u, 1u,  3u,  4u,  5u,  6u,  5u, 2u,  4u, 0u, 1u, 0u);
  let ST: array<u32, 15> = array<u32, 15>(1u, 2u, 7u, 7u, 3u,  4u,  5u,  6u,  7u,  7u, 7u,  7u, 7u, 7u, 7u);
  var v: array<U256, 7>;
  v[0] = a;
  var t: U256 = a;
  for (var i: u32 = 0u; i < 15u; i = i + 1u) {
    t = fp_mul(fp_sqr_n(t, N[i]), v[M[i]]);
    if (ST[i] < 7u) { v[ST[i]] = t; }
  }
  return t;
}

fn fp_neg(a: U256) -> U256 {
  if (u256_is_zero(a)) { return a; }
  let r = u256_sub_raw(U256(P_LIMBS), a);
  return r.diff;
}
`;

const secp256k1WGSL = /* wgsl */ `
struct Point { x: U256, y: U256, z: U256 };

fn point_infinity() -> Point {
  return Point(u256_zero(), u256_zero(), u256_zero());
}

fn is_infinity(p: Point) -> bool {
  return u256_is_zero(p.z);
}

fn fp_dbl(a: U256) -> U256 { return fp_add(a, a); }
fn fp_tri(a: U256) -> U256 { return fp_add(fp_dbl(a), a); }

fn point_double(p: Point) -> Point {
  if (is_infinity(p)) { return p; }
  let y2 = fp_sqr(p.y);
  let xy2 = fp_mul(p.x, y2);
  let s = fp_dbl(fp_dbl(xy2));
  let m = fp_tri(fp_sqr(p.x));
  let x3 = fp_sub(fp_sqr(m), fp_dbl(s));
  let y4 = fp_sqr(y2);
  let y8 = fp_dbl(fp_dbl(fp_dbl(y4)));
  let y3 = fp_sub(fp_mul(m, fp_sub(s, x3)), y8);
  let z3 = fp_dbl(fp_mul(p.y, p.z));
  return Point(x3, y3, z3);
}

fn point_add_mixed(p1: Point, qx: U256, qy: U256) -> Point {
  if (is_infinity(p1)) {
    return Point(qx, qy, u256_one());
  }

  let z1_sq = fp_sqr(p1.z);
  let z1_cu = fp_mul(z1_sq, p1.z);

  let u1 = p1.x;
  let u2 = fp_mul(qx, z1_sq);
  let s1 = p1.y;
  let s2 = fp_mul(qy, z1_cu);

  if (u256_eq(u1, u2)) {
    if (u256_eq(s1, s2)) {
      return point_double(p1);
    }
    return point_infinity();
  }

  let h = fp_sub(u2, u1);
  let r = fp_sub(s2, s1);
  let h_sq = fp_sqr(h);
  let h_cu = fp_mul(h_sq, h);
  let u1_h_sq = fp_mul(u1, h_sq);

  let x3 = fp_sub(fp_sub(fp_sqr(r), h_cu), fp_dbl(u1_h_sq));
  let y3 = fp_sub(fp_mul(r, fp_sub(u1_h_sq, x3)), fp_mul(s1, h_cu));
  let z3 = fp_mul(h, p1.z);
  return Point(x3, y3, z3);
}
`;

const sha256WGSL = /* wgsl */ `
const SHA_K: array<u32, 64> = array<u32, 64>(
  0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
  0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
  0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
  0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
  0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
  0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
  0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
  0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
);

fn rotr32(x: u32, n: u32) -> u32 {
  return (x >> n) | (x << (32u - n));
}

fn sha256_pubkey33(w: array<u32, 9>) -> array<u32, 8> {
  var W: array<u32, 64>;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) { W[i] = w[i]; }
  W[8] = (w[8] & 0xFF000000u) | 0x00800000u;
  for (var i: u32 = 9u; i < 15u; i = i + 1u) { W[i] = 0u; }
  W[15] = 264u;
  for (var i: u32 = 16u; i < 64u; i = i + 1u) {
    let s0 = rotr32(W[i - 15u], 7u) ^ rotr32(W[i - 15u], 18u) ^ (W[i - 15u] >> 3u);
    let s1 = rotr32(W[i - 2u], 17u) ^ rotr32(W[i - 2u], 19u) ^ (W[i - 2u] >> 10u);
    W[i] = W[i - 16u] + s0 + W[i - 7u] + s1;
  }
  var a = 0x6a09e667u; var b = 0xbb67ae85u; var c = 0x3c6ef372u; var d = 0xa54ff53au;
  var e = 0x510e527fu; var f = 0x9b05688cu; var g = 0x1f83d9abu; var h = 0x5be0cd19u;
  for (var i: u32 = 0u; i < 64u; i = i + 1u) {
    let S1 = rotr32(e, 6u) ^ rotr32(e, 11u) ^ rotr32(e, 25u);
    let ch = (e & f) ^ (~e & g);
    let t1 = h + S1 + ch + SHA_K[i] + W[i];
    let S0 = rotr32(a, 2u) ^ rotr32(a, 13u) ^ rotr32(a, 22u);
    let maj = (a & b) ^ (a & c) ^ (b & c);
    let t2 = S0 + maj;
    h = g; g = f; f = e;
    e = d + t1;
    d = c; c = b; b = a;
    a = t1 + t2;
  }
  return array<u32, 8>(
    0x6a09e667u + a, 0xbb67ae85u + b, 0x3c6ef372u + c, 0xa54ff53au + d,
    0x510e527fu + e, 0x9b05688cu + f, 0x1f83d9abu + g, 0x5be0cd19u + h
  );
}
`;

const ripemd160WGSL = /* wgsl */ `
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
   8u,  5u, 12u,  9u, 12u,  5u, 14u,  6u,  8u, 13u,  6u,  5u, 15u, 13u, 11u, 11u
);

fn rotl32(x: u32, n: u32) -> u32 {
  return (x << n) | (x >> (32u - n));
}

fn ripemd160_sha32(m: array<u32, 8>) -> array<u32, 5> {
  var X: array<u32, 16>;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) { X[i] = m[i]; }
  X[8] = 0x80u;
  for (var i: u32 = 9u; i < 16u; i = i + 1u) { X[i] = 0u; }
  X[14] = 256u;

  var A = 0x67452301u; var B = 0xEFCDAB89u; var C = 0x98BADCFEu; var D = 0x10325476u; var E = 0xC3D2E1F0u;
  var Ap = A; var Bp = B; var Cp = C; var Dp = D; var Ep = E;
  var T: u32;

  for (var j: u32 = 0u; j < 16u; j = j + 1u) {
    T = rotl32(A + (B ^ C ^ D) + X[RM_R_L[j]], RM_S_L[j]) + E;
    A = E; E = D; D = rotl32(C, 10u); C = B; B = T;
    T = rotl32(Ap + (Bp ^ (Cp | ~Dp)) + X[RM_R_R[j]] + 0x50A28BE6u, RM_S_R[j]) + Ep;
    Ap = Ep; Ep = Dp; Dp = rotl32(Cp, 10u); Cp = Bp; Bp = T;
  }
  for (var j: u32 = 16u; j < 32u; j = j + 1u) {
    T = rotl32(A + ((B & C) | (~B & D)) + X[RM_R_L[j]] + 0x5A827999u, RM_S_L[j]) + E;
    A = E; E = D; D = rotl32(C, 10u); C = B; B = T;
    T = rotl32(Ap + ((Bp & Dp) | (Cp & ~Dp)) + X[RM_R_R[j]] + 0x5C4DD124u, RM_S_R[j]) + Ep;
    Ap = Ep; Ep = Dp; Dp = rotl32(Cp, 10u); Cp = Bp; Bp = T;
  }
  for (var j: u32 = 32u; j < 48u; j = j + 1u) {
    T = rotl32(A + ((B | ~C) ^ D) + X[RM_R_L[j]] + 0x6ED9EBA1u, RM_S_L[j]) + E;
    A = E; E = D; D = rotl32(C, 10u); C = B; B = T;
    T = rotl32(Ap + ((Bp | ~Cp) ^ Dp) + X[RM_R_R[j]] + 0x6D703EF3u, RM_S_R[j]) + Ep;
    Ap = Ep; Ep = Dp; Dp = rotl32(Cp, 10u); Cp = Bp; Bp = T;
  }
  for (var j: u32 = 48u; j < 64u; j = j + 1u) {
    T = rotl32(A + ((B & D) | (C & ~D)) + X[RM_R_L[j]] + 0x8F1BBCDCu, RM_S_L[j]) + E;
    A = E; E = D; D = rotl32(C, 10u); C = B; B = T;
    T = rotl32(Ap + ((Bp & Cp) | (~Bp & Dp)) + X[RM_R_R[j]] + 0x7A6D76E9u, RM_S_R[j]) + Ep;
    Ap = Ep; Ep = Dp; Dp = rotl32(Cp, 10u); Cp = Bp; Bp = T;
  }
  for (var j: u32 = 64u; j < 80u; j = j + 1u) {
    T = rotl32(A + (B ^ (C | ~D)) + X[RM_R_L[j]] + 0xA953FD4Eu, RM_S_L[j]) + E;
    A = E; E = D; D = rotl32(C, 10u); C = B; B = T;
    T = rotl32(Ap + (Bp ^ Cp ^ Dp) + X[RM_R_R[j]], RM_S_R[j]) + Ep;
    Ap = Ep; Ep = Dp; Dp = rotl32(Cp, 10u); Cp = Bp; Bp = T;
  }
  return array<u32, 5>(
    0xEFCDAB89u + C + Dp,
    0x98BADCFEu + D + Ep,
    0x10325476u + E + Ap,
    0xC3D2E1F0u + A + Bp,
    0x67452301u + B + Cp
  );
}
`;

export const SECP256K1_HASH160_WGSL =
  bigintWGSL +
  secp256k1WGSL +
  sha256WGSL +
  ripemd160WGSL +
  /* wgsl */ `
struct ThreadOffset {
  x: U256,
  y: U256,
};

const OFFSET_TABLE_BITS: u32 = ${OFFSET_TABLE_BITS}u;
const BATCH_HALF: u32 = ${BATCH_HALF}u;
const BATCH_KEYS: u32 = ${BATCH_KEYS}u;
const KG_ENTRIES: u32 = ${KG_ENTRIES}u;

struct SearchParams {
  base_x: U256,
  base_y: U256,
  target_pkh: array<u32, 5>,
  keys_per_thread: u32,
  offset_table: array<ThreadOffset, OFFSET_TABLE_BITS>,
  kg_table: array<ThreadOffset, KG_ENTRIES>,
};

struct FoundKey {
  thread_id: u32,
  key_offset: u32,
};

struct SearchOutput {
  found_count: atomic<u32>,
  results: array<FoundKey, ${MAX_HITS}>,
  pow_count: atomic<u32>,
  pow_results: array<FoundKey, ${MAX_POW_HITS}>,
};

@group(0) @binding(0) var<storage, read>       params: SearchParams;
@group(0) @binding(1) var<storage, read_write> result: SearchOutput;

fn pubkey_to_sha_input(x: U256, prefix: u32) -> array<u32, 9> {
  var w: array<u32, 9>;
  w[0] = (prefix << 24u) | ((x.limbs[7] >> 8u) & 0x00FFFFFFu);
  for (var i: u32 = 1u; i < 8u; i = i + 1u) {
    let hi   = (x.limbs[8u - i] & 0xFFu) << 24u;
    let lo24 = (x.limbs[7u - i] >> 8u) & 0x00FFFFFFu;
    w[i] = hi | lo24;
  }
  w[8] = (x.limbs[0] & 0xFFu) << 24u;
  return w;
}

fn bswap32(x: u32) -> u32 {
  let a = (x >> 24u) & 0x000000FFu;
  let b = (x >> 8u)  & 0x0000FF00u;
  let c = (x << 8u)  & 0x00FF0000u;
  let d = (x << 24u) & 0xFF000000u;
  return a | b | c | d;
}

fn pkh_eq(pkh: array<u32, 5>, tgt: array<u32, 5>) -> bool {
  var diff: u32 = 0u;
  for (var i: u32 = 0u; i < 5u; i = i + 1u) {
    diff = diff | (pkh[i] ^ tgt[i]);
  }
  return diff == 0u;
}

fn hash_affine(x: U256, y: U256) -> array<u32, 5> {
  let prefix = select(0x02u, 0x03u, (y.limbs[0] & 1u) == 1u);
  let sha = sha256_pubkey33(pubkey_to_sha_input(x, prefix));
  var rm_in: array<u32, 8>;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) { rm_in[i] = bswap32(sha[i]); }
  return ripemd160_sha32(rm_in);
}

fn check_point(t: u32, offset: u32, x: U256, y: U256) {
  let pkh = hash_affine(x, y);
  if (pkh_eq(pkh, params.target_pkh)) {
    let idx = atomicAdd(&result.found_count, 1u);
    if (idx < ${MAX_HITS}u) {
      result.results[idx].thread_id = t;
      result.results[idx].key_offset = offset;
    }
  }
  if ((pkh[0] & 0x00FFFFFFu) == 0u) {
    let pidx = atomicAdd(&result.pow_count, 1u);
    if (pidx < ${MAX_POW_HITS}u) {
      result.pow_results[pidx].thread_id = t;
      result.pow_results[pidx].key_offset = offset;
    }
  }
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn search(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  let S = params.keys_per_thread;
  if (S == 0u) { return; }

  var R = point_infinity();
  for (var b: u32 = 0u; b < OFFSET_TABLE_BITS; b = b + 1u) {
    if (((t >> b) & 1u) == 1u) {
      R = point_add_mixed(R, params.offset_table[b].x, params.offset_table[b].y);
    }
  }
  R = point_add_mixed(R, params.base_x, params.base_y);
  R = point_add_mixed(R, params.kg_table[BATCH_HALF - 1u].x, params.kg_table[BATCH_HALF - 1u].y);

  let z_inv = fp_inv(R.z);
  let z_inv_sq = fp_sqr(z_inv);
  let z_inv_cu = fp_mul(z_inv_sq, z_inv);
  var px = fp_mul(R.x, z_inv_sq);
  var py = fp_mul(R.y, z_inv_cu);

  var A: array<U256, KG_ENTRIES>;
  var c: u32 = BATCH_HALF;

  for (; c - BATCH_HALF < S; c = c + BATCH_KEYS) {
    A[0] = fp_sub(params.kg_table[0].x, px);
    for (var i: u32 = 1u; i < KG_ENTRIES; i = i + 1u) {
      A[i] = fp_mul(A[i - 1u], fp_sub(params.kg_table[i].x, px));
    }
    var u = fp_inv(A[KG_ENTRIES - 1u]);
    for (var i: u32 = KG_ENTRIES - 1u; i > 0u; i = i - 1u) {
      let inv_i = fp_mul(u, A[i - 1u]);
      u = fp_mul(u, fp_sub(params.kg_table[i].x, px));
      A[i] = inv_i;
    }
    A[0] = u;

    if (c < S) { check_point(t, c, px, py); }

    for (var i: u32 = 0u; i < BATCH_HALF; i = i + 1u) {
      let inv = A[i];
      let gx = params.kg_table[i].x;
      let gy = params.kg_table[i].y;
      let sum_x = fp_add(px, gx);
      for (var s: u32 = 0u; s < 2u; s = s + 1u) {
        var num: U256;
        var offset: u32;
        if (s == 0u) {
          num = fp_sub(gy, py);
          offset = c + 1u + i;
        } else {
          num = fp_sub(fp_neg(gy), py);
          offset = c - 1u - i;
        }
        if (offset < S) {
          let lam = fp_mul(num, inv);
          let x3 = fp_sub(fp_sqr(lam), sum_x);
          let y3 = fp_sub(fp_mul(lam, fp_sub(px, x3)), py);
          check_point(t, offset, x3, y3);
        }
      }
    }

    let gs = params.kg_table[KG_ENTRIES - 1u];
    let ls = fp_mul(fp_sub(gs.y, py), A[KG_ENTRIES - 1u]);
    let xs = fp_sub(fp_sqr(ls), fp_add(px, gs.x));
    let ys = fp_sub(fp_mul(ls, fp_sub(px, xs)), py);
    px = xs;
    py = ys;
  }
}
`;

export function packU256LEBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 0; i < 8; i++) {
    const limb = Number(v & 0xffffffffn);
    out[i * 4] = limb & 0xff;
    out[i * 4 + 1] = (limb >>> 8) & 0xff;
    out[i * 4 + 2] = (limb >>> 16) & 0xff;
    out[i * 4 + 3] = (limb >>> 24) & 0xff;
    v >>= 32n;
  }
  return out;
}

export function bigintToLimbsLE(value: bigint): Uint32Array {
  const limbs = new Uint32Array(8);
  let v = value;
  const mask = 0xffffffffn;
  for (let i = 0; i < 8; i++) {
    limbs[i] = Number(v & mask);
    v >>= 32n;
  }
  return limbs;
}

export function hex20BytesToU32LE(hash160Hex: string): Uint32Array {
  const out = new Uint32Array(5);
  for (let i = 0; i < 5; i++) {
    const chunk = hash160Hex.slice(i * 8, i * 8 + 8);
    const b0 = parseInt(chunk.slice(0, 2), 16);
    const b1 = parseInt(chunk.slice(2, 4), 16);
    const b2 = parseInt(chunk.slice(4, 6), 16);
    const b3 = parseInt(chunk.slice(6, 8), 16);
    out[i] = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
  }
  return out;
}

/**
 * Packs kg_table[0..127] = 1*G .. 128*G and kg_table[128] = 257*G into 8256 bytes.
 */
export function buildKgTableBytes(): Uint8Array {
  const bytes = new Uint8Array(KG_TABLE_BYTES);
  const G = secp256k1.Point.BASE;
  let pt = G;
  for (let i = 0; i < BATCH_HALF; i++) {
    const affine = pt.toAffine();
    bytes.set(packU256LEBytes(affine.x), i * 64);
    bytes.set(packU256LEBytes(affine.y), i * 64 + 32);
    if (i + 1 < BATCH_HALF) {
      pt = pt.add(G);
    }
  }
  const stepPt = G.multiply(BigInt(BATCH_KEYS)).toAffine();
  bytes.set(packU256LEBytes(stepPt.x), BATCH_HALF * 64);
  bytes.set(packU256LEBytes(stepPt.y), BATCH_HALF * 64 + 32);
  return bytes;
}

/**
 * Packs offset_table[b] = (2^b * stride) * G for b = 0..21 into 1408 bytes.
 */
export function buildOffsetTableBytes(stride: number): Uint8Array {
  const bytes = new Uint8Array(TABLE_BYTES);
  let pt = secp256k1.Point.BASE.multiply(BigInt(stride));
  for (let b = 0; b < OFFSET_TABLE_BITS; b++) {
    const affine = pt.toAffine();
    bytes.set(packU256LEBytes(affine.x), b * 64);
    bytes.set(packU256LEBytes(affine.y), b * 64 + 32);
    if (b + 1 < OFFSET_TABLE_BITS) {
      pt = pt.double();
    }
  }
  return bytes;
}

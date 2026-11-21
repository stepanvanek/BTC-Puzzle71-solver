// 256-bit (8 limb) and 512-bit (16 limb) unsigned integer math in WGSL.
// Limbs are little-endian: limb[0] is least significant 32 bits.
// All field operations are modulo p = 2^256 - 2^32 - 977 (secp256k1 prime).

export const bigintWGSL = /* wgsl */ `

struct U256 { limbs: array<u32, 8> };
struct U512 { limbs: array<u32, 16> };

// p = 2^256 - 0x1000003D1
// Little-endian limbs:
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

// Returns 1u if a >= b, else 0u.
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

// (a + b) -> (sum, carry)
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

// (a - b) -> (diff, borrow)
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

// 32 x 32 -> 64 multiplication, returned as vec2<u32>(lo, hi).
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

// 256 x 256 -> 512.
fn u256_mul(a: U256, b: U256) -> U512 {
  var r: U512;
  for (var i: u32 = 0u; i < 16u; i = i + 1u) { r.limbs[i] = 0u; }
  for (var i: u32 = 0u; i < 8u; i = i + 1u) {
    var carry: u32 = 0u;
    for (var j: u32 = 0u; j < 8u; j = j + 1u) {
      let prod: vec2<u32> = mul32(a.limbs[i], b.limbs[j]);
      // r[i+j] += prod.x + carry, then propagate prod.y + new carry into r[i+j+1]
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

// Add a small 3-limb value (t0 + t1*2^32 + t2*2^64) into r[0..7], rippling the carry
// through every limb with no early exit, and return the carry out of limb 7.
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

// Reduce a 512-bit value mod p, where p = 2^256 - C and C = 2^32 + 977.
// a = lo + hi * 2^256  =>  a mod p = lo + hi * C (mod p).
//
// Straight-line: a fixed number of folds with no data-dependent loop exits, so
// every thread in a workgroup takes the same path. The bounds that make each
// fold's size fixed:
//   fold 1: lo + hi*977 + hi<<32 < 2^289, so the overflow above 256 bits is a
//           33-bit value e = r8 + r9<<32 with r9 in {0, 1}.
//   fold 2: e*C < 2^66, added to r[0..7] gives a carry c3 in {0, 1}.
//   fold 3: c3*C < 2^33, carry c4 in {0, 1}, and c4 = 1 only if the value was
//           already >= p, leaving a residue below C.
//   fold 4: c4*C added to a residue below C cannot carry (2C < p).
// Then one conditional subtract of p, since the result is < 2^256 < 2p.
// Verified limb-for-limb against BigInt (random, extremes, and adversarial
// near-2^512 inputs) before being written here.
fn mod_p(a: U512) -> U256 {
  var r: array<u32, 8>;
  for (var i: u32 = 0u; i < 8u; i = i + 1u) { r[i] = a.limbs[i]; }
  var r8: u32 = 0u;
  var r9: u32 = 0u;

  // Fold 1, step A: r[0..8] += hi * 977.
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
  // Fold 1, step B: r[1..9] += hi (hi shifted up by 32 bits).
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
    r9 = c1 + c2;   // 0 or 1
  }

  // Fold 2: e = r8 + r9<<32; r += e*977 + e<<32, as a 3-limb addend.
  let p977 = mul32(r8, 977u);
  let t0 = p977.x;
  let u1 = p977.y + r8;
  let uc = u32(u1 < p977.y);
  let t1 = u1 + r9 * 977u;
  let tc = u32(t1 < u1);
  let t2 = r9 + uc + tc;
  let c3 = add3_ripple(&r, t0, t1, t2);

  // Fold 3 and 4: c*C = c*977 + c<<32.
  let c4 = add3_ripple(&r, c3 * 977u, c3, 0u);
  _ = add3_ripple(&r, c4 * 977u, c4, 0u);   // carry is provably zero here

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
  // s can be up to 2p-2 + carry; reduce.
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

// Squaring is deliberately a plain multiply. A dedicated u256_sqr (28 cross products
// doubled plus 8 diagonals, 36 mul32 instead of 64) was built, verified, and measured
// 2026-09-11 in the real kernel on an Apple M1: Chrome (Tint) LOST 4% (7.14 to 6.88
// MK/s) while Deno (naga) gained 9%. Same register-pressure trap as the unrolling
// experiment in docs/wgsl-unroll-experiment.md: three passes over a live U512 cost
// more occupancy than the 28 saved multiplies bought. Browser is the product.
fn fp_sqr(a: U256) -> U256 {
  return fp_mul(a, a);
}

// n successive squarings. n is uniform across the workgroup so the loop does not diverge.
fn fp_sqr_n(a: U256, n: u32) -> U256 {
  var r = a;
  for (var i: u32 = 0u; i < n; i = i + 1u) { r = fp_sqr(r); }
  return r;
}

// Modular inverse via Fermat: a^(p-2) mod p, using libsecp256k1's addition chain.
// p - 2 in binary is five blocks of ones with lengths {1, 2, 22, 223} separated
// by zeros, so build a^(2^n - 1) for n in [1], [2], 3, 6, 9, 11, [22], 44, 88,
// 176, 220, [223] and assemble with a sliding window. 255 squarings and 15
// multiplies, against 255 squarings and 254 multiplies for bit-by-bit
// square-and-multiply. Chain verified against BigInt pow(a, p-2, p).
//
// WRITTEN AS A TABLE-DRIVEN LOOP ON PURPOSE. The obvious straight-line form
// (fifteen dependent fp_mul/fp_sqr_n lets) is MISCOMPILED by naga on Metal:
// Firefox 155 and Deno 2.9 both return values with zeroed high limbs for any
// three or more dependent field multiplies written in straight-line code, while
// the identical operations inside a loop are correct. Chrome (Tint) is correct
// either way. The miscompile predates this change: fp_sqr(fp_sqr(fp_sqr(a)))
// already failed on the shipped code, but nothing in the suite or the kernel
// had that shape. Step i does t = t^(2^N[i]) * v[M[i]] and stores t in v[ST[i]]
// when a later step needs it (7 = no store).
fn fp_inv(a: U256) -> U256 {
  let N:  array<u32, 15> = array<u32, 15>(1u, 1u, 3u, 3u, 2u, 11u, 22u, 44u, 88u, 44u, 3u, 23u, 5u, 3u, 2u);
  let M:  array<u32, 15> = array<u32, 15>(0u, 0u, 2u, 2u, 1u,  3u,  4u,  5u,  6u,  5u, 2u,  4u, 0u, 1u, 0u);
  let ST: array<u32, 15> = array<u32, 15>(1u, 2u, 7u, 7u, 3u,  4u,  5u,  6u,  7u,  7u, 7u,  7u, 7u, 7u, 7u);
  // v[0] = a, v[1] = x2, v[2] = x3, v[3] = x11, v[4] = x22, v[5] = x44, v[6] = x88.
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

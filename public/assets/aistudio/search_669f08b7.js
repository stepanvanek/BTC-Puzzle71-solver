// Search shader. The hot path is affine batch addition around a centre point:
//
//   per thread: start = base + (t * keys_per_thread) * G          (Jacobian, from the bit-walk table)
//               centre P = start + BATCH_HALF * G, converted to affine once
//   per batch of BATCH = 2 * BATCH_HALF + 1 consecutive keys:
//               dx_k = Gx_k - Px for k = 1..BATCH_HALF and for k = BATCH, batch-inverted with
//               Montgomery's trick (ONE Fermat inverse per batch), then from each inverse BOTH
//               P + kG and P - kG by one affine addition each (1 sqr + 1 mul), hashed at once.
//               The centre then advances by BATCH * G using the extra table entry, so the next
//               batch needs no second inverse.
//
// Why affine rather than Jacobian: a Jacobian mixed add is 11 field ops per key and still needs
// a batch inversion plus 4 ops of affine conversion before hashing (about 26 field ops per key
// all told, against about 4 op-equivalents for both hashes). Here a key costs 1 sqr + 1 mul plus
// its share of the batch inversion, about 6.6 field ops at BATCH_HALF = 64. Every infinity and
// doubling case is unreachable by construction, PROVIDED the chunk start is above BATCH_KEYS:
// dx = 0 for table entry k needs the centre to be +-kG, i.e. a centre key of k (k <= BATCH_HALF,
// or BATCH_KEYS for the step entry) or n - k, and a centre's key is chunk_start + t*S + BATCH_HALF
// + j*BATCH_KEYS. The coordinator floors every chunk start at BATCH_KEYS + 1, so the smallest
// centre key is BATCH_KEYS + 1 + BATCH_HALF and no entry can match; a zero dx would otherwise
// zero the batch product and corrupt every key of that thread's batch. Puzzle chunk starts are
// about 2^70 anyway; the floor is for test ranges and for the claim to be true rather than
// likely. docs/affine-batch-plan.md.
//
// Offsets. Thread t owns keys [t*S, t*S + S) of the chunk, S = keys_per_thread. The first
// centre sits at offset BATCH_HALF; its plus points are offsets c+1..c+BATCH_HALF and its minus
// points c-1..c-BATCH_HALF. A point is hashed only when its offset is < S, so any S works,
// including the small odd values the smoke tests and the watchdog-recovery path use; the batch
// arithmetic is simply spent on fewer keys then. The hit record is (t, offset) exactly as before,
// so the CPU reconstructs chunk_start + t * S + offset unchanged.
//
// `base_pub` is the affine pubkey for the chunk's starting privkey, computed on the CPU (one
// scalar mul per chunk, amortized). Output: atomic counter + small fixed-size hit array.
//
// Constraints this shape respects, all measured (docs/affine-batch-plan.md): dependent field
// multiplies live inside loop bodies (naga miscompiles straight-line chains of three or more; the
// batch inversion is loop-carried and the point formulas sit in the sign loop), ONE per-thread
// array of KG_ENTRIES U256 (4,128 bytes at BATCH_HALF 128, under Safari's 8 KB function-scope
// cap; dx is recomputed as a subtraction rather than stored, which is what freed the second
// array and let the batch double), and a per-key live set of a handful of U256 (Tint loses
// occupancy, and with it throughput, when that grows).

import { secp256k1WGSL } from "./secp256k1.js";
import { sha256WGSL } from "./sha256.js";
import { ripemd160WGSL } from "./ripemd160.js";

// Shared with the CPU side (coordinator, tests): the CPU builds the kG table with these and
// sizes the params buffer from them. Changing BATCH_HALF changes the WGSL, so it changes the
// capability-check fingerprint and every device re-runs the suite, which is what should happen.
export const BATCH_HALF = 128;                // kG table holds k = 1..BATCH_HALF
export const BATCH_KEYS = 2 * BATCH_HALF + 1; // keys per batch: centre, BATCH_HALF above, BATCH_HALF below
export const KG_ENTRIES = BATCH_HALF + 1;     // plus one entry for BATCH_KEYS * G, the centre step
export const OFFSET_TABLE_BITS = 22;

export const searchWGSL = secp256k1WGSL + sha256WGSL + ripemd160WGSL + /* wgsl */ `

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
  // offset_table[k] = (2^k * keys_per_thread) * G in affine form. CPU writes once per stride.
  offset_table: array<ThreadOffset, OFFSET_TABLE_BITS>,
  // kg_table[i] = (i + 1) * G for i < BATCH_HALF, and kg_table[BATCH_HALF] = BATCH_KEYS * G.
  // Independent of keys_per_thread; CPU writes once at setup.
  kg_table: array<ThreadOffset, KG_ENTRIES>,
};

struct FoundKey {
  thread_id: u32,
  key_offset: u32,
};

struct SearchOutput {
  found_count: atomic<u32>,
  results: array<FoundKey, 16>,
};

@group(0) @binding(0) var<storage, read>       params: SearchParams;
@group(0) @binding(1) var<storage, read_write> result: SearchOutput;

// The 33-byte compressed pubkey as nine big-endian words: prefix byte, then the 32 X bytes,
// the last of which lands in the top byte of w[8]; sha256_pubkey33 adds the padding.
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

// hash160 of the compressed encoding of an affine point.
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
    if (idx < 16u) {
      result.results[idx].thread_id = t;
      result.results[idx].key_offset = offset;
    }
  }
}

@compute @workgroup_size(64)
fn search(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  let S = params.keys_per_thread;
  if (S == 0u) { return; }

  // Per-thread starting point in Jacobian form: walk the bits of t, summing precomputed
  // multiples (2^k * S) * G from the CPU-uploaded table, add base_pub, then step to the first
  // centre with + BATCH_HALF * G (the table's last plain entry).
  var R = point_infinity();
  for (var b: u32 = 0u; b < OFFSET_TABLE_BITS; b = b + 1u) {
    if (((t >> b) & 1u) == 1u) {
      R = point_add_mixed(R, params.offset_table[b].x, params.offset_table[b].y);
    }
  }
  R = point_add_mixed(R, params.base_x, params.base_y);
  R = point_add_mixed(R, params.kg_table[BATCH_HALF - 1u].x, params.kg_table[BATCH_HALF - 1u].y);

  // To affine, once per thread. Same shape as the shipped hash_with_zinv conversion.
  let z_inv = fp_inv(R.z);
  let z_inv_sq = fp_sqr(z_inv);
  let z_inv_cu = fp_mul(z_inv_sq, z_inv);
  var px = fp_mul(R.x, z_inv_sq);
  var py = fp_mul(R.y, z_inv_cu);

  // A: the running products of dx_i on the way forward, the inverses dx_i^-1 on the way back.
  // dx_i itself is one subtraction, so it is recomputed rather than stored.
  var A: array<U256, KG_ENTRIES>;
  var c: u32 = BATCH_HALF;   // offset of the current centre within this thread's slice

  // Uniform loop: S and c are the same for every thread.
  for (; c - BATCH_HALF < S; c = c + BATCH_KEYS) {
    // Forward pass: running products of dx_i = Gx_i - px.
    A[0] = fp_sub(params.kg_table[0].x, px);
    for (var i: u32 = 1u; i < KG_ENTRIES; i = i + 1u) {
      A[i] = fp_mul(A[i - 1u], fp_sub(params.kg_table[i].x, px));
    }
    // One Fermat inverse for the whole batch, then walk back to every dx_i^-1, overwriting the
    // product at i once the product at i-1 has been consumed. dx_i is recomputed, not stored.
    var u = fp_inv(A[KG_ENTRIES - 1u]);
    for (var i: u32 = KG_ENTRIES - 1u; i > 0u; i = i - 1u) {
      let inv_i = fp_mul(u, A[i - 1u]);
      u = fp_mul(u, fp_sub(params.kg_table[i].x, px));
      A[i] = inv_i;
    }
    A[0] = u;

    // The centre itself.
    if (c < S) { check_point(t, c, px, py); }

    // P + kG and P - kG for k = 1..BATCH_HALF, each lambda from the shared inverse: the plus
    // lambda is (Gy - Py) * inv, the minus lambda (-Gy - Py) * inv. The sign loop keeps one copy of
    // the hash in the body, and the lambda, square and multiply chain sits inside a loop body on
    // purpose (naga's straight-line miscompile). Every branch here is uniform across the workgroup.
    for (var i: u32 = 0u; i < BATCH_HALF; i = i + 1u) {
      let inv = A[i];
      let gx = params.kg_table[i].x;
      let gy = params.kg_table[i].y;
      let sum_x = fp_add(px, gx);
      for (var s: u32 = 0u; s < 2u; s = s + 1u) {
        var num: U256;
        var offset: u32;
        if (s == 0u) { num = fp_sub(gy, py); offset = c + 1u + i; } else { num = fp_sub(fp_neg(gy), py); offset = c - 1u - i; }
        if (offset < S) {
          let lam = fp_mul(num, inv);
          let x3 = fp_sub(fp_sqr(lam), sum_x);
          let y3 = fp_sub(fp_mul(lam, fp_sub(px, x3)), py);
          check_point(t, offset, x3, y3);
        }
      }
    }

    // Advance the centre by BATCH_KEYS * G with the step entry's inverse.
    let gs = params.kg_table[KG_ENTRIES - 1u];
    let ls = fp_mul(fp_sub(gs.y, py), A[KG_ENTRIES - 1u]);
    let xs = fp_sub(fp_sqr(ls), fp_add(px, gs.x));
    let ys = fp_sub(fp_mul(ls, fp_sub(px, xs)), py);
    px = xs;
    py = ys;
  }
}
`;

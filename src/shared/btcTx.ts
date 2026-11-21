import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { calculatePayoutSplit, validateBitcoinAddress } from './btcAddress.ts';
import { ADMIN_PAYOUT_ADDRESS } from './puzzle71.ts';

export interface PuzzleUtxoInput {
  txid: string;
  vout: number;
  valueSats: bigint;
}

export interface BuildPuzzleTxParams {
  privateKey: bigint;
  utxo?: PuzzleUtxoInput;
  utxos?: PuzzleUtxoInput[];
  userAddress: string;
  adminAddress?: string;
  feeRateSatPerVb?: number;
  explicitFeeSats?: bigint;
}

export interface SignedPuzzleTxResult {
  txHex: string;
  txid: string;
  vbytes: number;
  inputCount: number;
  totalInputSats: bigint;
  feeSats: bigint;
  userSats: bigint;
  adminSats: bigint;
  userAddress: string;
  userAddressType: string;
  adminAddress: string;
  compressedPubKeyHex: string;
  pubKeyHash160Hex: string;
  signatureVerified: boolean;
}

function writeUint32LE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value >>> 0, true);
  return buf;
}

function writeUint64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, value, true);
  return buf;
}

function writeVarInt(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    new DataView(buf.buffer).setUint16(1, n, true);
    return buf;
  }
  const buf = new Uint8Array(5);
  buf[0] = 0xfe;
  new DataView(buf.buffer).setUint32(1, n >>> 0, true);
  return buf;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(len);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

function reverseBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[bytes.length - 1 - i];
  }
  return out;
}

export function privateKeyBigIntToBytes(privKey: bigint): Uint8Array {
  if (privKey <= 0n) {
    throw new Error('Private key must be a positive integer.');
  }
  return hex.decode(privKey.toString(16).padStart(64, '0'));
}

export function privateKeyToCompressedPubKey(privKey: bigint): Uint8Array {
  const privBytes = privateKeyBigIntToBytes(privKey);
  return secp256k1.getPublicKey(privBytes, true);
}

export function hash160(bytes: Uint8Array): Uint8Array {
  return ripemd160(sha256(bytes));
}

export function privateKeyToHash160Hex(privKey: bigint): string {
  return hex.encode(hash160(privateKeyToCompressedPubKey(privKey)));
}

function compactSigToDer(compact64: Uint8Array): Uint8Array {
  const r = compact64.slice(0, 32);
  const s = compact64.slice(32, 64);

  const trimInt = (bytes: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const sliced = bytes.slice(i);
    if (sliced[0] & 0x80) {
      return concatBytes(Uint8Array.of(0x00), sliced);
    }
    return sliced;
  };

  const rDer = trimInt(r);
  const sDer = trimInt(s);
  const body = concatBytes(
    Uint8Array.of(0x02, rDer.length),
    rDer,
    Uint8Array.of(0x02, sDer.length),
    sDer,
  );
  return concatBytes(Uint8Array.of(0x30, body.length), body);
}

/**
 * Estimates legacy P2PKH multi-input, 2-output transaction vbytes accurately.
 */
export function estimatePuzzleTxVbytes(
  userScriptLen: number,
  adminScriptLen: number,
  inputCount = 1,
): number {
  return (
    4 +
    1 +
    inputCount * (36 + 1 + 107 + 4) +
    1 +
    (8 + 1 + userScriptLen) +
    (8 + 1 + adminScriptLen) +
    4
  );
}

/**
 * Builds and signs a real multi-input P2PKH spend transaction in the browser with 85% to user
 * and 15% to admin, deducting the miner fee BEFORE splitting.
 */
export function buildAndSignPuzzle71Tx(params: BuildPuzzleTxParams): SignedPuzzleTxResult {
  const adminAddr = params.adminAddress ?? ADMIN_PAYOUT_ADDRESS;

  const userValidation = validateBitcoinAddress(params.userAddress);
  if (!userValidation.valid || !userValidation.parsed) {
    throw new Error(userValidation.error ?? 'Invalid user payout address.');
  }

  const adminValidation = validateBitcoinAddress(adminAddr);
  if (!adminValidation.valid || !adminValidation.parsed) {
    throw new Error(adminValidation.error ?? 'Invalid admin payout address.');
  }

  const rawInputs =
    params.utxos && params.utxos.length > 0
      ? params.utxos
      : params.utxo
        ? [params.utxo]
        : [];

  if (rawInputs.length === 0) {
    throw new Error('Missing input UTXO to build transaction.');
  }

  const feeRate = Math.max(2, Math.round(params.feeRateSatPerVb ?? 12));
  // Filter out uneconomical dust UTXOs whose value is less than the marginal fee to spend one P2PKH input
  const marginalInputCost = BigInt(148 * feeRate);
  const inputs =
    rawInputs.length > 1
      ? rawInputs.filter((u) => u.valueSats > marginalInputCost)
      : rawInputs;
  const activeInputs = inputs.length > 0 ? inputs : [rawInputs[0]];

  for (const inp of activeInputs) {
    if (!/^[0-9a-fA-F]{64}$/.test(inp.txid)) {
      throw new Error('Invalid input UTXO TXID.');
    }
  }

  const totalInputSats = activeInputs.reduce((acc, u) => acc + u.valueSats, 0n);

  const userScript = userValidation.parsed.scriptPubKey;
  const adminScript = adminValidation.parsed.scriptPubKey;

  const estimatedVb = estimatePuzzleTxVbytes(
    userScript.length,
    adminScript.length,
    activeInputs.length,
  );
  const feeSats = params.explicitFeeSats ?? BigInt(estimatedVb * feeRate);

  const split = calculatePayoutSplit(totalInputSats, feeSats);

  const privBytes = privateKeyBigIntToBytes(params.privateKey);
  const pubKey = secp256k1.getPublicKey(privBytes, true);
  const pubKeyHash = hash160(pubKey);

  // Input scriptPubKey for P2PKH Puzzle #71 address: OP_DUP OP_HASH160 <20B> OP_EQUALVERIFY OP_CHECKSIG
  const inputScriptCode = concatBytes(
    Uint8Array.of(0x76, 0xa9, 0x14),
    pubKeyHash,
    Uint8Array.of(0x88, 0xac),
  );

  const versionBytes = writeUint32LE(2);
  const locktimeBytes = writeUint32LE(0);
  const sequenceBytes = writeUint32LE(0xfffffffd);

  const outputsBytes = concatBytes(
    writeVarInt(2),
    writeUint64LE(split.userSats),
    writeVarInt(userScript.length),
    userScript,
    writeUint64LE(split.adminSats),
    writeVarInt(adminScript.length),
    adminScript,
  );

  const txidLEList = activeInputs.map((inp) => reverseBytes(hex.decode(inp.txid.toLowerCase())));

  let allSignaturesVerified = true;
  const signedInputChunks: Uint8Array[] = [];

  for (let idx = 0; idx < activeInputs.length; idx++) {
    const preimageInputs: Uint8Array[] = [writeVarInt(activeInputs.length)];
    for (let j = 0; j < activeInputs.length; j++) {
      const script = j === idx ? inputScriptCode : new Uint8Array(0);
      preimageInputs.push(
        txidLEList[j],
        writeUint32LE(activeInputs[j].vout),
        writeVarInt(script.length),
        script,
        sequenceBytes,
      );
    }

    const preimage = concatBytes(
      versionBytes,
      ...preimageInputs,
      outputsBytes,
      locktimeBytes,
      writeUint32LE(0x01), // SIGHASH_ALL
    );

    const sighash = doubleSha256(preimage);
    const compactSig = secp256k1.sign(sighash, privBytes, { prehash: false, lowS: true });
    if (!secp256k1.verify(compactSig, sighash, pubKey, { prehash: false, lowS: true })) {
      allSignaturesVerified = false;
    }

    const derSigPlusHashType = concatBytes(compactSigToDer(compactSig), Uint8Array.of(0x01));
    const scriptSig = concatBytes(
      Uint8Array.of(derSigPlusHashType.length),
      derSigPlusHashType,
      Uint8Array.of(pubKey.length),
      pubKey,
    );

    signedInputChunks.push(
      txidLEList[idx],
      writeUint32LE(activeInputs[idx].vout),
      writeVarInt(scriptSig.length),
      scriptSig,
      sequenceBytes,
    );
  }

  if (!allSignaturesVerified) {
    throw new Error('Internal ECDSA signature verification failed.');
  }

  const finalTx = concatBytes(
    versionBytes,
    writeVarInt(activeInputs.length),
    ...signedInputChunks,
    outputsBytes,
    locktimeBytes,
  );

  const txid = hex.encode(reverseBytes(doubleSha256(finalTx)));

  return {
    txHex: hex.encode(finalTx),
    txid,
    vbytes: finalTx.length,
    inputCount: activeInputs.length,
    totalInputSats: split.totalInputSats,
    feeSats: split.feeSats,
    userSats: split.userSats,
    adminSats: split.adminSats,
    userAddress: userValidation.parsed.normalizedAddress,
    userAddressType: userValidation.parsed.type,
    adminAddress: adminValidation.parsed.normalizedAddress,
    compressedPubKeyHex: hex.encode(pubKey),
    pubKeyHash160Hex: hex.encode(pubKeyHash),
    signatureVerified: allSignaturesVerified,
  };
}

export interface VerifySignedPuzzleTxParams {
  rawTxHex: string;
  expectedHash160Hex?: string;
  expectedUserScript?: Uint8Array;
  expectedAdminScript?: Uint8Array;
  allowedUtxos?: PuzzleUtxoInput[];
  enforceAllowedUtxos?: boolean;
}

export interface VerifiedSignedPuzzleTx {
  txid: string;
  inputCount: number;
  inputs: Array<{ txid: string; vout: number }>;
  userSats: bigint;
  adminSats: bigint;
  totalInputSats: bigint;
  feeSats: bigint;
  pubKeyHash160Hex: string;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function readVarInt(buf: Uint8Array, offset: number): { value: number; nextOffset: number } {
  if (offset >= buf.length) {
    throw new Error('Unexpected end of transaction while reading varint.');
  }
  const prefix = buf[offset];
  if (prefix < 0xfd) {
    return { value: prefix, nextOffset: offset + 1 };
  }
  if (prefix === 0xfd) {
    if (offset + 3 > buf.length) {
      throw new Error('Truncated 16-bit varint.');
    }
    const value = new DataView(buf.buffer, buf.byteOffset + offset + 1, 2).getUint16(0, true);
    if (value < 0xfd) throw new Error('Non-canonical 16-bit varint.');
    return { value, nextOffset: offset + 3 };
  }
  if (prefix === 0xfe) {
    if (offset + 5 > buf.length) {
      throw new Error('Truncated 32-bit varint.');
    }
    const value = new DataView(buf.buffer, buf.byteOffset + offset + 1, 4).getUint32(0, true);
    if (value <= 0xffff) throw new Error('Non-canonical 32-bit varint.');
    return { value, nextOffset: offset + 5 };
  }
  throw new Error('64-bit varint is not supported in standard transactions.');
}

function readSlice(buf: Uint8Array, offset: number, length: number): { bytes: Uint8Array; nextOffset: number } {
  if (length < 0 || offset + length > buf.length) {
    throw new Error('Unexpected end of transaction payload.');
  }
  return {
    bytes: buf.slice(offset, offset + length),
    nextOffset: offset + length,
  };
}

function parseDerSigToCompact64(derBytes: Uint8Array): Uint8Array {
  if (derBytes.length < 8 || derBytes[0] !== 0x30) {
    throw new Error('Invalid DER signature header.');
  }
  const bodyLen = derBytes[1];
  if (bodyLen + 2 !== derBytes.length) {
    throw new Error('Invalid DER signature length.');
  }
  let pos = 2;
  const parseIntPart = (): Uint8Array => {
    if (pos + 2 > derBytes.length || derBytes[pos] !== 0x02) {
      throw new Error('Invalid DER integer marker.');
    }
    const len = derBytes[pos + 1];
    pos += 2;
    if (len === 0 || pos + len > derBytes.length) {
      throw new Error('Invalid DER integer length.');
    }
    let slice = derBytes.slice(pos, pos + len);
    pos += len;
    if (slice[0] & 0x80) {
      throw new Error('Negative DER integer is invalid.');
    }
    if (slice.length > 1 && slice[0] === 0x00) {
      if ((slice[1] & 0x80) === 0) {
        throw new Error('Non-minimal DER padding.');
      }
      slice = slice.slice(1);
    }
    if (slice.length > 32) {
      throw new Error('DER scalar exceeds 32 bytes.');
    }
    const padded = new Uint8Array(32);
    padded.set(slice, 32 - slice.length);
    return padded;
  };

  const r = parseIntPart();
  const s = parseIntPart();
  if (pos !== derBytes.length) {
    throw new Error('Trailing bytes in DER signature.');
  }
  return concatBytes(r, s);
}

/**
 * Parses a raw P2PKH transaction and cryptographically verifies its structure,
 * ECDSA SIGHASH_ALL signatures, optional Puzzle #71 Hash160, UTXOs, and 85%/15% payout split.
 */
export function verifySignedPuzzleTx(params: VerifySignedPuzzleTxParams): VerifiedSignedPuzzleTx {
  const cleanHex = params.rawTxHex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(cleanHex) || cleanHex.length < 120 || cleanHex.length > 200_000 || cleanHex.length % 2 !== 0) {
    throw new Error('Invalid raw hex transaction format.');
  }
  const rawBytes = hex.decode(cleanHex);
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);

  if (rawBytes.length < 60) {
    throw new Error('Transaction payload is too short.');
  }

  let offset = 0;
  const versionBytes = rawBytes.slice(0, 4);
  const version = view.getUint32(0, true);
  if (version < 1 || version > 2) {
    throw new Error('Unsupported transaction version.');
  }
  offset += 4;

  const inCountInfo = readVarInt(rawBytes, offset);
  offset = inCountInfo.nextOffset;
  if (inCountInfo.value < 1 || inCountInfo.value > 256) {
    throw new Error('Invalid transaction input count.');
  }

  const parsedInputs: Array<{
    txidLE: Uint8Array;
    txid: string;
    vout: number;
    scriptSig: Uint8Array;
    sequenceBytes: Uint8Array;
  }> = [];

  for (let i = 0; i < inCountInfo.value; i += 1) {
    const txidSlice = readSlice(rawBytes, offset, 32);
    offset = txidSlice.nextOffset;
    const voutSlice = readSlice(rawBytes, offset, 4);
    offset = voutSlice.nextOffset;
    const vout = new DataView(
      voutSlice.bytes.buffer,
      voutSlice.bytes.byteOffset,
      4,
    ).getUint32(0, true);
    const scriptLenInfo = readVarInt(rawBytes, offset);
    offset = scriptLenInfo.nextOffset;
    if (scriptLenInfo.value < 70 || scriptLenInfo.value > 200) {
      throw new Error('Invalid P2PKH scriptSig length.');
    }
    const scriptSlice = readSlice(rawBytes, offset, scriptLenInfo.value);
    offset = scriptSlice.nextOffset;
    const seqSlice = readSlice(rawBytes, offset, 4);
    offset = seqSlice.nextOffset;

    parsedInputs.push({
      txidLE: txidSlice.bytes,
      txid: hex.encode(reverseBytes(txidSlice.bytes)),
      vout,
      scriptSig: scriptSlice.bytes,
      sequenceBytes: seqSlice.bytes,
    });
  }

  const outputsStartOffset = offset;
  const outCountInfo = readVarInt(rawBytes, offset);
  offset = outCountInfo.nextOffset;
  if (outCountInfo.value !== 2) {
    throw new Error('Payout transaction must contain exactly 2 outputs (user + platform).');
  }

  const outputs: Array<{ valueSats: bigint; scriptPubKey: Uint8Array }> = [];
  for (let i = 0; i < outCountInfo.value; i += 1) {
    const valSlice = readSlice(rawBytes, offset, 8);
    offset = valSlice.nextOffset;
    const valueSats = new DataView(
      valSlice.bytes.buffer,
      valSlice.bytes.byteOffset,
      8,
    ).getBigUint64(0, true);
    const scriptLenInfo = readVarInt(rawBytes, offset);
    offset = scriptLenInfo.nextOffset;
    if (scriptLenInfo.value < 2 || scriptLenInfo.value > 100) {
      throw new Error('Invalid output scriptPubKey length.');
    }
    const scriptSlice = readSlice(rawBytes, offset, scriptLenInfo.value);
    offset = scriptSlice.nextOffset;
    outputs.push({ valueSats, scriptPubKey: scriptSlice.bytes });
  }
  const outputsEndOffset = offset;
  const outputsBytes = rawBytes.slice(outputsStartOffset, outputsEndOffset);

  const locktimeSlice = readSlice(rawBytes, offset, 4);
  offset = locktimeSlice.nextOffset;
  if (offset !== rawBytes.length) {
    throw new Error('Transaction contains unexpected trailing bytes.');
  }

  const userOutput = outputs[0];
  const adminOutput = outputs[1];
  if (params.expectedUserScript && !bytesEqual(userOutput.scriptPubKey, params.expectedUserScript)) {
    throw new Error('Transaction user output does not match the session Bitcoin address.');
  }
  if (params.expectedAdminScript && !bytesEqual(adminOutput.scriptPubKey, params.expectedAdminScript)) {
    throw new Error('Transaction platform output does not match the authorized payout address.');
  }

  let signerHash160Hex = '';
  for (let idx = 0; idx < parsedInputs.length; idx += 1) {
    const ss = parsedInputs[idx].scriptSig;
    const sigPlusTypeLen = ss[0];
    if (sigPlusTypeLen < 9 || 1 + sigPlusTypeLen + 1 + 33 !== ss.length) {
      throw new Error('Invalid P2PKH scriptSig push structure.');
    }
    const sigPlusType = ss.slice(1, 1 + sigPlusTypeLen);
    const sigHashType = sigPlusType[sigPlusType.length - 1];
    if (sigHashType !== 0x01) {
      throw new Error('Only SIGHASH_ALL (0x01) signatures are permitted.');
    }
    const derSig = sigPlusType.slice(0, sigPlusType.length - 1);
    const pubLen = ss[1 + sigPlusTypeLen];
    if (pubLen !== 33) {
      throw new Error('Expected 33-byte compressed public key in scriptSig.');
    }
    const pubKey = ss.slice(1 + sigPlusTypeLen + 1);
    if (pubKey[0] !== 0x02 && pubKey[0] !== 0x03) {
      throw new Error('Invalid compressed public key prefix.');
    }

    const pubKeyHash = hash160(pubKey);
    const pubHashHex = hex.encode(pubKeyHash);
    if (params.expectedHash160Hex && pubHashHex !== params.expectedHash160Hex.toLowerCase()) {
      throw new Error('Transaction input public key does not match Puzzle #71 Hash160.');
    }
    if (!signerHash160Hex) {
      signerHash160Hex = pubHashHex;
    } else if (signerHash160Hex !== pubHashHex) {
      throw new Error('All inputs must be signed by the same Puzzle #71 public key.');
    }

    const inputScriptCode = concatBytes(
      Uint8Array.of(0x76, 0xa9, 0x14),
      pubKeyHash,
      Uint8Array.of(0x88, 0xac),
    );
    const preimageInputs: Uint8Array[] = [writeVarInt(parsedInputs.length)];
    for (let j = 0; j < parsedInputs.length; j += 1) {
      const script = j === idx ? inputScriptCode : new Uint8Array(0);
      preimageInputs.push(
        parsedInputs[j].txidLE,
        writeUint32LE(parsedInputs[j].vout),
        writeVarInt(script.length),
        script,
        parsedInputs[j].sequenceBytes,
      );
    }

    const preimage = concatBytes(
      versionBytes,
      ...preimageInputs,
      outputsBytes,
      locktimeSlice.bytes,
      writeUint32LE(0x01),
    );
    const sighash = doubleSha256(preimage);
    const compactSig = parseDerSigToCompact64(derSig);
    if (!secp256k1.verify(compactSig, sighash, pubKey, { prehash: false, lowS: true })) {
      throw new Error(`Invalid ECDSA signature on input #${idx}.`);
    }
  }

  let totalInputSats = 0n;
  let feeSats = 0n;
  if (params.enforceAllowedUtxos) {
    const allowedMap = new Map<string, bigint>();
    for (const u of params.allowedUtxos ?? []) {
      allowedMap.set(`${u.txid.toLowerCase()}:${u.vout}`, u.valueSats);
    }
    const seen = new Set<string>();
    for (const inp of parsedInputs) {
      const key = `${inp.txid.toLowerCase()}:${inp.vout}`;
      if (seen.has(key)) {
        throw new Error('Duplicate UTXO input in transaction.');
      }
      seen.add(key);
      const val = allowedMap.get(key);
      if (val === undefined) {
        throw new Error(`Input ${inp.txid}:${inp.vout} is not an active Puzzle #71 UTXO.`);
      }
      totalInputSats += val;
    }
    const outputSum = userOutput.valueSats + adminOutput.valueSats;
    if (outputSum >= totalInputSats) {
      throw new Error('Transaction outputs exceed or leave zero fee from Puzzle #71 UTXOs.');
    }
    feeSats = totalInputSats - outputSum;
    const expectedSplit = calculatePayoutSplit(totalInputSats, feeSats);
    if (
      userOutput.valueSats !== expectedSplit.userSats ||
      adminOutput.valueSats !== expectedSplit.adminSats
    ) {
      throw new Error('Transaction outputs do not match the 85% / 15% payout split.');
    }
  }

  return {
    txid: hex.encode(reverseBytes(doubleSha256(rawBytes))),
    inputCount: parsedInputs.length,
    inputs: parsedInputs.map((i) => ({ txid: i.txid, vout: i.vout })),
    userSats: userOutput.valueSats,
    adminSats: adminOutput.valueSats,
    totalInputSats,
    feeSats,
    pubKeyHash160Hex: signerHash160Hex,
  };
}

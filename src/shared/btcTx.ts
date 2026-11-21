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

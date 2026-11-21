import { sha256 } from '@noble/hashes/sha2.js';
import { bech32, bech32m, createBase58check, hex } from '@scure/base';
import type { Locale } from '../i18n/locale.ts';

const base58check = createBase58check(sha256);

export type BitcoinAddressType =
  | 'P2PKH (Legacy)'
  | 'P2SH (Script Hash)'
  | 'P2WPKH (SegWit v0)'
  | 'P2WSH (SegWit v0)'
  | 'P2TR (Taproot v1)'
  | `SegWit v${number} (Bech32m)`;

export interface ParsedBitcoinAddress {
  address: string;
  normalizedAddress: string;
  type: BitcoinAddressType;
  versionLabel: string;
  encoding: 'Base58Check' | 'Bech32' | 'Bech32m';
  witnessVersion: number | null;
  program: Uint8Array;
  scriptPubKey: Uint8Array;
  scriptPubKeyHex: string;
}

export interface ValidationResult {
  valid: boolean;
  parsed?: ParsedBitcoinAddress;
  error?: string;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function encodePushData(data: Uint8Array): Uint8Array {
  if (data.length > 75) {
    throw new Error('Unsupported witness script program length.');
  }
  return concatBytes(Uint8Array.of(data.length), data);
}

/**
 * Validates and compiles scriptPubKey for ALL Bitcoin mainnet address versions:
 * - Base58Check P2PKH (1..., version 0x00, 20 bytes)
 * - Base58Check P2SH (3..., version 0x05, 20 bytes)
 * - Bech32 SegWit v0 P2WPKH (bc1q..., 20 bytes) & P2WSH (bc1q..., 32 bytes)
 * - Bech32m Taproot v1 P2TR (bc1p..., 32 bytes)
 * - Bech32m Future SegWit witness versions v2..v16 (bc1z..., bc1r..., 2..40 bytes)
 */
export function validateBitcoinAddress(rawInput: string, locale: Locale = 'en'): ValidationResult {
  const isCs = locale === 'cs';
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return {
      valid: false,
      error: isCs ? 'Zadejte prosím bitcoinovou adresu.' : 'Please enter a Bitcoin address.',
    };
  }

  const lower = trimmed.toLowerCase();

  // Reject non-mainnet prefixes explicitly
  if (
    lower.startsWith('tb1') ||
    lower.startsWith('bcrt1') ||
    trimmed.startsWith('m') ||
    trimmed.startsWith('n') ||
    trimmed.startsWith('2')
  ) {
    return {
      valid: false,
      error: isCs
        ? 'Testnet/Regtest adresy nejsou podporovány. Zadejte prosím Bitcoin mainnet adresu.'
        : 'Testnet/Regtest addresses are not supported. Please enter a Bitcoin mainnet address.',
    };
  }

  // SegWit Bech32 / Bech32m (bc1...)
  if (lower.startsWith('bc1')) {
    if (trimmed !== trimmed.toLowerCase() && trimmed !== trimmed.toUpperCase()) {
      return {
        valid: false,
        error: isCs
          ? 'Bech32/Bech32m adresa nesmí kombinovat malá a velká písmena.'
          : 'Bech32/Bech32m addresses cannot mix lowercase and uppercase characters.',
      };
    }

    const normalized = lower;

    // Try Bech32 first (strictly valid ONLY for witness version 0 per BIP-350)
    const decodedBech32 = bech32.decodeUnsafe(normalized, 90);
    const decodedBech32m = bech32m.decodeUnsafe(normalized, 90);

    if (!decodedBech32 && !decodedBech32m) {
      return {
        valid: false,
        error: isCs
          ? 'Neplatný Bech32/Bech32m kontrolní součet nebo formát adresy.'
          : 'Invalid Bech32/Bech32m checksum or address format.',
      };
    }

    if (decodedBech32) {
      if (decodedBech32.prefix !== 'bc' || decodedBech32.words.length < 1) {
        return {
          valid: false,
          error: isCs ? 'Neplatný prefix SegWit adresy.' : 'Invalid SegWit address prefix.',
        };
      }
      const witnessVersion = decodedBech32.words[0];
      if (witnessVersion !== 0) {
        return {
          valid: false,
          error: isCs
            ? `Witness verze v${witnessVersion} musí používat Bech32m (BIP-350), nikoliv starší Bech32.`
            : `Witness version v${witnessVersion} must use Bech32m (BIP-350), not legacy Bech32.`,
        };
      }
      const program = bech32.fromWordsUnsafe(decodedBech32.words.slice(1));
      if (!program) {
        return {
          valid: false,
          error: isCs
            ? 'Poškozený witness program v Bech32 adrese.'
            : 'Malformed witness program in Bech32 address.',
        };
      }
      if (program.length !== 20 && program.length !== 32) {
        return {
          valid: false,
          error: isCs
            ? `SegWit v0 vyžaduje 20 nebo 32 bajtů programu (nalezeno ${program.length} B).`
            : `SegWit v0 requires a 20- or 32-byte program (found ${program.length} bytes).`,
        };
      }
      const scriptPubKey = concatBytes(Uint8Array.of(0x00), encodePushData(program));
      const type: BitcoinAddressType =
        program.length === 20 ? 'P2WPKH (SegWit v0)' : 'P2WSH (SegWit v0)';
      return {
        valid: true,
        parsed: {
          address: trimmed,
          normalizedAddress: normalized,
          type,
          versionLabel: `SegWit v0 · ${program.length === 20 ? 'P2WPKH' : 'P2WSH'}`,
          encoding: 'Bech32',
          witnessVersion: 0,
          program,
          scriptPubKey,
          scriptPubKeyHex: hex.encode(scriptPubKey),
        },
      };
    }

    if (decodedBech32m) {
      if (decodedBech32m.prefix !== 'bc' || decodedBech32m.words.length < 1) {
        return {
          valid: false,
          error: isCs ? 'Neplatný prefix Bech32m adresy.' : 'Invalid Bech32m address prefix.',
        };
      }
      const witnessVersion = decodedBech32m.words[0];
      if (witnessVersion === 0) {
        return {
          valid: false,
          error: isCs
            ? 'SegWit v0 adresa musí používat Bech32, nikoliv Bech32m (BIP-350).'
            : 'SegWit v0 addresses must use Bech32, not Bech32m (BIP-350).',
        };
      }
      if (witnessVersion < 1 || witnessVersion > 16) {
        return {
          valid: false,
          error: isCs
            ? `Neplatná witness verze v${witnessVersion} (povoleno v0–v16).`
            : `Invalid witness version v${witnessVersion} (allowed v0–v16).`,
        };
      }
      const program = bech32m.fromWordsUnsafe(decodedBech32m.words.slice(1));
      if (!program) {
        return {
          valid: false,
          error: isCs
            ? 'Poškozený witness program v Bech32m adrese.'
            : 'Malformed witness program in Bech32m address.',
        };
      }
      if (program.length < 2 || program.length > 40) {
        return {
          valid: false,
          error: isCs
            ? `Witness program musí mít délku 2–40 bajtů (nalezeno ${program.length} B).`
            : `Witness program must be 2–40 bytes long (found ${program.length} bytes).`,
        };
      }
      if (witnessVersion === 1 && program.length !== 32) {
        const opVer = 0x50 + witnessVersion;
        const scriptPubKey = concatBytes(Uint8Array.of(opVer), encodePushData(program));
        return {
          valid: true,
          parsed: {
            address: trimmed,
            normalizedAddress: normalized,
            type: 'SegWit v1 (Bech32m)',
            versionLabel: `SegWit v1 · ${program.length}B witness`,
            encoding: 'Bech32m',
            witnessVersion,
            program,
            scriptPubKey,
            scriptPubKeyHex: hex.encode(scriptPubKey),
          },
        };
      }

      const opVer = 0x50 + witnessVersion;
      const scriptPubKey = concatBytes(Uint8Array.of(opVer), encodePushData(program));
      const type: BitcoinAddressType =
        witnessVersion === 1 ? 'P2TR (Taproot v1)' : `SegWit v${witnessVersion} (Bech32m)`;
      return {
        valid: true,
        parsed: {
          address: trimmed,
          normalizedAddress: normalized,
          type,
          versionLabel:
            witnessVersion === 1 ? 'Taproot v1 · P2TR' : `SegWit v${witnessVersion} · Bech32m`,
          encoding: 'Bech32m',
          witnessVersion,
          program,
          scriptPubKey,
          scriptPubKeyHex: hex.encode(scriptPubKey),
        },
      };
    }
  }

  // Base58Check Legacy P2PKH (1...) or P2SH (3...)
  if (trimmed.startsWith('1') || trimmed.startsWith('3')) {
    try {
      const payload = base58check.decode(trimmed);
      if (payload.length !== 21) {
        return {
          valid: false,
          error: isCs
            ? `Neplatná délka Base58Check adresy (${payload.length} B místo 21 B).`
            : `Invalid Base58Check address length (${payload.length} bytes instead of 21).`,
        };
      }
      const version = payload[0];
      const hash = payload.slice(1);
      if (version === 0x00) {
        const scriptPubKey = concatBytes(
          Uint8Array.of(0x76, 0xa9, 0x14),
          hash,
          Uint8Array.of(0x88, 0xac),
        );
        return {
          valid: true,
          parsed: {
            address: trimmed,
            normalizedAddress: trimmed,
            type: 'P2PKH (Legacy)',
            versionLabel: 'Legacy · P2PKH',
            encoding: 'Base58Check',
            witnessVersion: null,
            program: hash,
            scriptPubKey,
            scriptPubKeyHex: hex.encode(scriptPubKey),
          },
        };
      }
      if (version === 0x05) {
        const scriptPubKey = concatBytes(
          Uint8Array.of(0xa9, 0x14),
          hash,
          Uint8Array.of(0x87),
        );
        return {
          valid: true,
          parsed: {
            address: trimmed,
            normalizedAddress: trimmed,
            type: 'P2SH (Script Hash)',
            versionLabel: 'Script Hash · P2SH',
            encoding: 'Base58Check',
            witnessVersion: null,
            program: hash,
            scriptPubKey,
            scriptPubKeyHex: hex.encode(scriptPubKey),
          },
        };
      }
      return {
        valid: false,
        error: isCs
          ? `Nepodporovaná verze Base58Check adresy (0x${version.toString(16)}).`
          : `Unsupported Base58Check address version (0x${version.toString(16)}).`,
      };
    } catch {
      return {
        valid: false,
        error: isCs
          ? 'Neplatný Base58Check kontrolní součet nebo nepovolené znaky v adrese.'
          : 'Invalid Base58Check checksum or unsupported characters in address.',
      };
    }
  }

  return {
    valid: false,
    error: isCs
      ? 'Neznámý formát BTC adresy. Podporovány jsou adresy 1..., 3..., bc1q..., bc1p... i novější bc1... (v2–v16).'
      : 'Unknown BTC address format. Supported formats are 1..., 3..., bc1q..., bc1p..., and future bc1... (v2–v16).',
  };
}

export interface PayoutSplit {
  totalInputSats: bigint;
  feeSats: bigint;
  netSats: bigint;
  userSats: bigint;
  adminSats: bigint;
}

export const DUST_LIMIT_SATS = 546n;

/**
 * Deducts the network miner fee FIRST, then splits the remaining net reward 85% user / 15% admin.
 */
export function calculatePayoutSplit(
  totalInputSats: bigint,
  feeSats: bigint,
  locale: Locale = 'en',
): PayoutSplit {
  const isCs = locale === 'cs';
  if (totalInputSats <= 0n) {
    throw new Error(isCs ? 'Vstupní částka UTXO musí být kladná.' : 'Input UTXO amount must be positive.');
  }
  if (feeSats < 0n) {
    throw new Error(isCs ? 'Síťový poplatek nesmí být záporný.' : 'Network fee cannot be negative.');
  }
  if (feeSats >= totalInputSats) {
    throw new Error(
      isCs ? 'Síťový poplatek převyšuje hodnotu UTXO.' : 'Network fee exceeds UTXO value.',
    );
  }
  const netSats = totalInputSats - feeSats;
  const userSats = (netSats * 85n) / 100n;
  const adminSats = netSats - userSats;

  if (userSats < DUST_LIMIT_SATS || adminSats < DUST_LIMIT_SATS) {
    throw new Error(
      isCs
        ? 'Výstupní částky po odečtení poplatku klesly pod dust limit (546 sat).'
        : 'Output amounts after fee fell below the dust limit (546 sat).',
    );
  }

  return {
    totalInputSats,
    feeSats,
    netSats,
    userSats,
    adminSats,
  };
}

export function formatBtcFromSats(sats: bigint): string {
  const whole = sats / 100_000_000n;
  const frac = (sats % 100_000_000n).toString().padStart(8, '0');
  return `${whole}.${frac} BTC`;
}

/**
 * Masks the middle of a Bitcoin address for public display, revealing only the prefix and suffix.
 * Example: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" -> "bc1qw5…kv8f3t4"
 */
export function maskBtcAddress(address: string, prefixChars = 6, suffixChars = 6): string {
  const trimmed = address.trim();
  if (!trimmed) return '—';
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}…${trimmed.slice(-2)}`;
  }
  const safePrefix = Math.min(prefixChars, Math.floor((trimmed.length - 2) / 2));
  const safeSuffix = Math.min(suffixChars, Math.floor((trimmed.length - 2) / 2));
  return `${trimmed.slice(0, safePrefix)}…${trimmed.slice(-safeSuffix)}`;
}

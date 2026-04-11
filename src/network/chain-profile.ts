export interface ChainProfile {
    networkId: string;
    ticker: string;
    bech32: string;
    messagePrefix: string;
    enableSegwit: boolean;
    pubKeyHash: number;
    scriptHash: number;
    wif: number;
    bip32Public: number;
    bip32Private: number;
    powDiff1TargetHex: string;
    stratumInitDiff: number;
    stratumMinDiff: number;
    stratumMaxDiff: number;
    stratumTargetSharesPerSecond: number;
}

const DEFAULT_DIFF1_TARGET = '00000000ffff0000000000000000000000000000000000000000000000000000';

function parseIntConfig(value: string | undefined, fallback: number): number {
    if (value == null || value.length === 0) {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.floor(parsed);
}

function parseFloatConfig(value: string | undefined, fallback: number): number {
    if (value == null || value.length === 0) {
        return fallback;
    }
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return parsed;
}

function parseBooleanConfig(value: string | undefined, fallback: boolean): boolean {
    if (value == null || value.length === 0) {
        return fallback;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
        return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
        return false;
    }
    return fallback;
}

function normalizeHex(value: string): string {
    let normalized = value.trim().toLowerCase();
    if (normalized.startsWith('0x')) {
        normalized = normalized.slice(2);
    }
    if (!/^[0-9a-f]+$/.test(normalized)) {
        return DEFAULT_DIFF1_TARGET;
    }
    if (normalized.length > 64) {
        normalized = normalized.slice(normalized.length - 64);
    }
    return normalized.padStart(64, '0');
}

function readEnv() {
    return process.env;
}

export function getActiveChainProfile(): ChainProfile {
    const env = readEnv();

    const networkId = (env.NETWORK ?? 'hcash').toLowerCase();
    const ticker = (env.CHAIN_TICKER ?? 'HCASH').toUpperCase();
    const bech32 = (env.CHAIN_BECH32 ?? 'hcash').toLowerCase();

    const stratumMinDiff = parseFloatConfig(env.STRATUM_MIN_DIFF, 0.00001);
    const stratumMaxDiff = Math.max(parseFloatConfig(env.STRATUM_MAX_DIFF, 16384), stratumMinDiff);
    const stratumInitDiff = Math.min(
        Math.max(parseFloatConfig(env.STRATUM_INIT_DIFF, 0.00015), stratumMinDiff),
        stratumMaxDiff
    );

    return {
        networkId,
        ticker,
        bech32,
        messagePrefix: env.CHAIN_MESSAGE_PREFIX ?? '\x18HashCash Signed Message:\n',
        enableSegwit: parseBooleanConfig(env.CHAIN_ENABLE_SEGWIT, false),
        pubKeyHash: parseIntConfig(env.CHAIN_PUBKEYHASH, 28),
        scriptHash: parseIntConfig(env.CHAIN_SCRIPTHASH, 88),
        wif: parseIntConfig(env.CHAIN_WIF, 212),
        bip32Public: parseIntConfig(env.CHAIN_BIP32_PUBLIC, 0x0488b21e),
        bip32Private: parseIntConfig(env.CHAIN_BIP32_PRIVATE, 0x0488ade4),
        powDiff1TargetHex: normalizeHex(env.POW_DIFF1_TARGET ?? DEFAULT_DIFF1_TARGET),
        stratumInitDiff,
        stratumMinDiff,
        stratumMaxDiff,
        stratumTargetSharesPerSecond: Math.max(parseFloatConfig(env.STRATUM_TARGET_SHARES_PER_SEC, 10), 0.001),
    };
}

export function getPowDiff1TargetAsBigInt(): bigint {
    return BigInt(`0x${getActiveChainProfile().powDiff1TargetHex}`);
}

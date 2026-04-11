import * as bitcoinjs from 'bitcoinjs-lib';
import { getActiveChainProfile } from './chain-profile';

function getChainNetwork(): bitcoinjs.networks.Network {
    const profile = getActiveChainProfile();
    return {
        messagePrefix: profile.messagePrefix,
        bech32: profile.bech32,
        bip32: {
            public: profile.bip32Public,
            private: profile.bip32Private,
        },
        pubKeyHash: profile.pubKeyHash,
        scriptHash: profile.scriptHash,
        wif: profile.wif,
    };
}

export function getHcashNetwork(): bitcoinjs.networks.Network {
    return getChainNetwork();
}

export function warnIfNonHcashNetwork(networkValue: string | undefined) {
    const profile = getActiveChainProfile();
    if (networkValue == null || networkValue.length === 0) {
        return;
    }
    if (networkValue.toLowerCase() !== profile.networkId) {
        console.warn(`NETWORK=${networkValue} does not match active chain profile ${profile.networkId}. Using active profile.`);
    }
}

export function isValidHcashAddress(address: string): boolean {
    try {
        bitcoinjs.address.toOutputScript(address, getChainNetwork());
        return true;
    } catch {
        return false;
    }
}

export function toHcashOutputScript(address: string): Buffer {
    return bitcoinjs.address.toOutputScript(address, getChainNetwork());
}

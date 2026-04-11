# HCASH Stratum Docker (Existing HashCash Node)

This setup runs `hc-pool` as a Stratum v1 + GBT pool against an existing `hashcash-core` regtest node.

## Topology

- Existing node stack: `../hashcash-core` (`hashcash-node1` RPC at `127.0.0.1:10309`)
- Pool stack: this repository (`hcash-pool-regtest`)
- RPC auth: cookie file mounted from node1

## Files

- Compose profile: `docker-compose.hcash-regtest.yml`
- Env file: `config/hcash-regtest.env`
- Validation script: `scripts/validate-hcash-regtest.sh`
- Chain/vardiff profile:
  - `CHAIN_*` for address encoding
  - `POW_DIFF1_TARGET` for difficulty normalization
  - `STRATUM_INIT_DIFF`, `STRATUM_MIN_DIFF`, `STRATUM_MAX_DIFF`, `STRATUM_TARGET_SHARES_PER_SEC`
  - optional one-shot bootstrap imprint controls:
    - `BOOTSTRAP_COINBASE_MESSAGE_ENABLED`
    - `BOOTSTRAP_COINBASE_MESSAGE`
    - `BOOTSTRAP_COINBASE_MESSAGE_HEIGHT_MAX`

## Startup Order

1. Start HashCash node stack:

```bash
cd ../hashcash-core
make regtest-up
```

2. Start pool stack:

```bash
cd ../hc-pool
docker compose -f docker-compose.hcash-regtest.yml up -d --build
```

3. Validate pool + stratum path:

```bash
./scripts/validate-hcash-regtest.sh
```

## Endpoints

- Stratum v1: `stratum+tcp://<host>:3333`
- Pool API: `http://127.0.0.1:3334/api`
- Network info: `http://127.0.0.1:3334/api/network`
- Pool stats: `http://127.0.0.1:3334/api/pool`

## Troubleshooting

- `Could not reach RPC host`:
  - ensure `hashcash-node1` is up
  - ensure `../hashcash-core/data/node1/regtest/.cookie` exists
  - ensure node1 RPC is published on `10309`
- `Authorization validation error` for valid miner credentials:
  - miner username must be `HCASH_ADDRESS.worker`
  - expected address prefixes: `hcash1...` (bech32), HCASH base58 prefixes
- `mining.notify` not received:
  - wait for `getmininginfo`/`getblocktemplate` cycle
  - check pool logs: `docker compose -f docker-compose.hcash-regtest.yml logs -f`
- Clean restart:

```bash
docker compose -f docker-compose.hcash-regtest.yml down --remove-orphans
rm -rf data/hcash-regtest/public-pool/*
docker compose -f docker-compose.hcash-regtest.yml up -d --build
```

# HCASH Pool (Stratum v1 + GBT)

NestJS + TypeScript stratum server configured for HCASH.

Protocol support:
- Stratum v1 (mining protocol)
- `getblocktemplate` (GBT) via JSON-RPC to `hashcashd`
- Not Stratum v2

## Canonical HCASH Docker Flow

This repository is intended to run against your existing `hashcash-core` devnet in `../hashcash-core`.

1. Start node stack:

```bash
cd ../hashcash-core
make regtest-up
```

2. Start pool stack:

```bash
cd ../hc-pool
docker compose -f docker-compose.hcash-regtest.yml up -d --build
```

3. Run deterministic validation:

```bash
./scripts/validate-hcash-regtest.sh
```

4. Stop pool stack:

```bash
docker compose -f docker-compose.hcash-regtest.yml down --remove-orphans
```

## HCASH Docker Profile

- Compose file: `docker-compose.hcash-regtest.yml`
- Env file: `config/hcash-regtest.env`
- Cookie mount:
  - source: `../hashcash-core/data/node1/regtest/.cookie`
  - target: `/run/hashcash/.cookie`
- RPC endpoint from container: `http://host.docker.internal:10309`
- Chain/profile defaults live in `config/hcash-regtest.env`:
  - address/network params (`CHAIN_*`)
  - PoW diff1 target (`POW_DIFF1_TARGET`)
  - vardiff tuning (`STRATUM_*`)

Ports:
- Stratum: `3333/tcp`
- API: `3334/tcp` (localhost bound)

## Miner Connection

- Stratum URL: `stratum+tcp://<host>:3333`
- Authorization format: `<HCASH_ADDRESS>.<worker>`
- Expected address support:
  - `hcash1...` bech32
  - HCASH legacy base58 prefixes

## Additional Docs

- Setup and troubleshooting: [docs/HCASH_STRATUM_DOCKER.md](docs/HCASH_STRATUM_DOCKER.md)
- Legacy full-stack examples: [full-setup/README.md](full-setup/README.md)

## Development

```bash
npm install
npm run build
npm run start
```

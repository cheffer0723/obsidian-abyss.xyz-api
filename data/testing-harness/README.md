# Testing harness market history

Daily adj-close research snapshot for Tape / Pulse / Fade historical harness testing only (not a live signal feed).

## Install data (required after clone)

MCP text uploads can corrupt long base64, so the 195 `*.gz.part.b64.SS` shards ship via a verified tarball:

```bash
npm run install:harness-shards
```

This downloads `https://litter.catbox.moe/rzsf0x.gz` (sha256 `858a01a2448103ad5c56ad0ac7cd237929b1cb22c9f0bef571abc384642a945e`), extracts 195 shards into `market-history.parts/`, and verifies the count.

Assembled history lastDate for all assets: **2026-09-22**.

Refresh from Yahoo (rebuilds local `market-history.json` + parts):

```bash
npm run refresh:harness-data
```

# TCC Contract SDK

Documentation and browser tools for writing, deploying and testing smart contracts
on the TCC chain (chain id 91338).

Published at **https://tccnetwork.github.io/tcc-sdk/**

- `index.html` — the SDK guide: the ABI, the host functions, gas, the deploy flow.
- `tools/tools.html` — deploy and call contracts from the browser, with a wallet
  derived in the page. Four ready-made programs ship alongside it: erc721, erc1155,
  token and poll.
- `tcc-client.js` — the shared client: RPC with failover, wallet derivation, signing,
  submission, nonce handling.

Everything here is static and self-contained: no CDN, no build step, no tracking.

## Which chain the tools talk to

The tools default to the public mainnet RPC (`rpc2` / `rpc3`), so a deploy from this
page spends real TCC — a transaction costs about 0.001 TCC.

A free public test chain (id 91339) also exists at `http://46.250.231.130:42107`
with a faucet at `http://46.250.231.130:42108/rpc`. It is reachable from curl and
from Node today, but **not from this page**: a browser refuses a plain-http call from
an https page. It becomes usable from the browser once the test chain has a name and
a certificate.

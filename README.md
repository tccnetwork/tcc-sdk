# TCC Contract SDK

Documentation and browser tools for writing, deploying and testing smart contracts
on the TCC chain (live chain, id 91338).

Published at **https://tccnetwork.github.io/tcc-sdk/**

- `index.html` — the SDK guide: the ABI, the host functions, gas, the deploy flow.
- `tools/tools.html` — deploy and call contracts from the browser, with a wallet
  derived in the page. Four ready-made programs ship alongside it: erc721, erc1155,
  token and poll.
- `tcc-client.js` — the shared client: RPC with failover, wallet derivation, signing,
  submission, nonce handling.

Everything here is static and self-contained: no CDN, no build step, no tracking.

## Which chain the tools talk to

The tools start on the test chain. Switching them to the live chain (91338, `rpc2` /
`rpc3`) means a deploy spends TCC that people actually hold — about 0.001 TCC per
transaction — and what you deploy stays on chain for good.

The free public test chain (id 91339) is at `https://rpc-test.tcc-coin.com/rpc`, with
a faucet at `https://faucet-test.tcc-coin.com/rpc` handing out 5 TCC per wallet per
hour — about five thousand transactions. Both answer over https with CORS open, so the
tools page talks to them directly, and it starts there by default: nobody spends real
TCC by accident on their first try.

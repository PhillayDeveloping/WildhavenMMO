# Third Party Notices

Wildhaven project code is licensed under the MIT License in `LICENSE`. Bundled
art asset credits are tracked separately in `CREDITS.md`.

This file exists to record notices that a third-party runtime dependency's
license obliges us to reproduce, above and beyond what `LICENSE` and `CREDITS.md`
already cover.

**There are currently no such dependencies.** The notices previously recorded
here (Reown AppKit, the WalletConnect packages, `@solana/web3.js`,
`@noble/curves`, `@noble/hashes`, `bs58`, `tweetnacl`, and `buffer`) all belonged
to the wallet-linking feature, which this project does not ship; none of those
packages is installed. The complete dependency graph remains pinned in
`pnpm-lock.yaml`.

Add a section here if you introduce a dependency whose license requires a
reproduced notice (anything that is not plain MIT/ISC/BSD/Apache-2.0 with no
NOTICE file), and put the license copy under `third_party/licenses/`.

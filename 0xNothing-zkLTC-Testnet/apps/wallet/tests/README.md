# Wallet tests

Tests are grouped by the boundary they protect:

- `config/`: deployment mirrors, extension metadata, and network configuration.
- `core/`: keyring, services, formatting, market math, and vault behavior.
- `extension/`: dapp admission, provider protocol, and RPC ingress.
- `security/`: cross-boundary fail-closed source contracts.
- `ui/`: translations, design-token parity, and action-review coordination.

Run the complete recursively discovered suite with `npm test`. Keep fixtures local
to their owning domain; create `tests/helpers/` or `tests/mocks/` only after a
helper is shared by multiple test files.

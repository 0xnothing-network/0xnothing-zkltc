# Web tests

Tests are grouped by the production boundary they cover:

- `client/`: browser-side coordination helpers.
- `data/`: exact parsing, numeric, and identifier rules.
- `media/`: image metadata validation.
- `server/`: server-only caching, request trust, bounded reads, rate limits, and security contracts.

Run the complete recursively discovered suite with `npm test`. Keep reusable fixtures
next to the domain that owns them; create `tests/helpers/` only when more than one
domain consumes the same helper.

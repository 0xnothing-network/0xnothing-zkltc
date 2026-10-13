# CI verification

Every pull request and every push to `main` runs `.github/workflows/verify.yml`.

The job:

1. Installs Node 22 with the six lockfile-backed npm caches.
2. Installs Foundry `v1.8.5` and caches `~/.svm`, Forge caches, and `out/` trees.
3. Runs `node scripts/ci-install.mjs` (`npm ci` in web, wallet, 0xFi, and the three subgraphs).
4. Runs `npm run verify` from the workspace root.

Reproduce locally with Foundry 1.8.5 and Node 22 on `PATH`:

```bash
node scripts/ci-install.mjs
npm run verify
```

The workflow has `contents: read` only, cancels superseded runs on the same ref, and times out at 45 minutes.

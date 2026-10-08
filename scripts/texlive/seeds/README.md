Seed documents for `scripts/build-texlive.mjs`.

Every TeX Live file the engine opens while compiling these documents (plus
`tests/fixtures/orgo-lab` and `templates/lab-report`) is packed into the
precached bundle, so these packages work offline from the first visit.
Anything else is fetched on demand from the package tree and cached.

To precache another package, use it in one of these documents and rebuild.

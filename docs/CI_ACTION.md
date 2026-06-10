# Keeping proof fresh automatically (the registry write-path)

Bootproof never uploads anything. The registry updates because attestations live in repos, and repos get pushed. To keep your repo's proof continuously fresh, add this workflow — every push re-attests and commits the result:

```yaml
name: bootproof
on:
  push: { branches: [main] }
jobs:
  attest:
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: npm i -g bootproof   # once published; until then: clone + npm link
      - run: bootproof up . --provider local --unsafe-local --install --timeout 120000
        continue-on-error: true   # a failed boot is still honest, classified proof
      - run: bootproof attest export .
      - name: commit refreshed proof
        run: |
          git config user.name bootproof-ci && git config user.email ci@bootproof.invalid
          git add .bootproof/ && git diff --cached --quiet || git commit -m "bootproof: refresh attestation [skip ci]"
          git push
```

Result: your repo always carries a current, signed, replayable answer to "does this boot from cold?" — and a boot regression fails loudly on the commit that caused it. Installing this workflow is the consent; there is no hidden telemetry to consent to.

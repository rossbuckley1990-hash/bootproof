# CI Usage

BootProof has a fail-closed machine interface:

```bash
bootproof up . --ci --json
```

Exit `0` means both `booted` and `healthVerified` are true. Every refusal or failure exits `1`.

## GitHub Actions Example

This example records the JSON result and preserves the signed attestation even when verification fails:

```yaml
name: bootproof

on:
  push:
    branches: [main]

jobs:
  bootproof:
    runs-on: ubuntu-latest
    permissions:
      contents: read

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"

      - run: npm install --global bootproof

      - name: Run BootProof
        id: bootproof
        continue-on-error: true
        shell: bash
        run: |
          mkdir -p .bootproof
          set +e
          bootproof up . --provider local --unsafe-local --install --timeout 120000 --ci --json \
            | tee .bootproof/result.json
          code=${PIPESTATUS[0]}
          echo "exit_code=$code" >> "$GITHUB_OUTPUT"
          exit "$code"

      - name: Upload evidence
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: bootproof-evidence
          path: .bootproof/

      - name: Enforce verdict
        if: steps.bootproof.outputs.exit_code != '0'
        run: exit 1
```

Review execution flags for the target repository. `--install` can run package-manager lifecycle scripts, and `--unsafe-local` acknowledges host execution.

## Current Trust Limitation

Running BootProof in CI does not automatically produce OIDC trust.

Current attestations still say:

```text
local_developer_signed
```

They are signed evidence generated on a CI runner, but they are not yet `ci_oidc_signed`. Workload-identity-backed signing remains future work.

BootProof does not silently push commits or upload evidence. The workflow owner chooses whether to retain artifacts or commit `.bootproof/`.

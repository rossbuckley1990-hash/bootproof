# CI Usage

BootProof has a fail-closed machine interface:

```bash
bootproof up . --ci --json
```

Exit `0` means both `booted` and `healthVerified` are true. Every refusal or failure exits `1`.

## BootProof GitHub Action

The GitHub Action runs the same deterministic CLI interface, writes a Markdown
job summary, and can post or update a sticky pull request comment:

```yaml
name: bootproof

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  bootproof:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - uses: bootproof/action@v1
        with:
          install: true
          diff: true
          upload-artifact: true
```

Evidence upload is explicit. `upload-artifact` defaults to `false`; setting it
to `true` uploads only the action's staged allowlist, including the attestation
when one was produced. It does not upload the whole `.bootproof/` directory.

The action can explicitly generate redacted registry or federated
public-candidate artifacts:

```yaml
      - uses: bootproof/action@v1
        with:
          registry-export: true
          federated-receipt: true
          upload-artifact: true
```

Nothing is committed or uploaded to a registry. Cloud upload is not
implemented in this OSS action, and Cloud inputs are rejected rather than
silently ignored.

The action never runs `bootproof fix`, `bootproof plan-agent`, agent actions,
or repair commands. If `agent-plan-summary` is enabled, it only summarises an
existing `.bootproof/agent-plan.json`.

The action uses its bundled compiled CLI when present. Release tags without a
bundle install the exact `bootproof` version declared by that action release;
they never prefer a target repository's local `bootproof` executable. Publish
that npm version before creating the corresponding action tag.

## Manual GitHub Actions Example

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
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: "22"
          package-manager-cache: false

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
        uses: actions/upload-artifact@v7
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

The action records GitHub workflow context as unsigned provenance metadata. It
does not request an OIDC token, emit `ci_oidc_signed`, or claim SLSA
provenance.

The action-owned machine artifacts use strict schemas:

- [`schemas/action-verdict-v1.schema.json`](schemas/action-verdict-v1.schema.json)
- [`schemas/ci-context-v1.schema.json`](schemas/ci-context-v1.schema.json)

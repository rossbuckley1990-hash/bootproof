# npm Release Checklist

BootProof publishes compiled JavaScript, not TypeScript source. `dist/` is required by the `bootproof` executable, generated during `prepack`, ignored by Git, and must not be committed.

## Before Publishing

1. Confirm the working tree contains only the intended release changes:

   ```bash
   git status --short
   ```

2. Install exactly the locked development dependencies:

   ```bash
   npm ci
   ```

3. Run a clean build and the full test suite:

   ```bash
   npm run build
   npm test
   ```

4. Pack and smoke-test the installed artifact:

   ```bash
   npm run pack:check
   ```

   This checks archive hygiene, installs the tarball under a temporary `HOME`, runs `bootproof --help`, exercises a signed early refusal, verifies and explains that attestation, verifies a healthy fixture, and checks that remote URL mode clones but refuses execution without the host safety gate.

5. Inspect the exact public archive:

   ```bash
   npm pack --dry-run
   npm publish --dry-run
   ```

   The archive must not contain `.git/`, `node_modules/`, `.DS_Store`, `.bootproof/`, local evidence, fixtures, test repositories, or source-only development files.

6. Confirm the package name, version, npm account, and registry target:

   ```bash
   npm view bootproof version
   npm whoami
   npm config get registry
   ```

## Publish

1. Commit the release changes and create the matching GitHub tag:

   ```bash
   VERSION="$(node -p "require('./package.json').version")"
   git tag "v${VERSION}"
   git push origin main --tags
   ```

2. Publish the public package:

   ```bash
   npm publish
   ```

3. Verify the published version and CLI directly from the registry:

   ```bash
   EXPECTED_VERSION="$(node -p "require('./package.json').version")"
   npm view bootproof version
   npx --yes bootproof@latest --help
   npx --yes "bootproof@${EXPECTED_VERSION}" --help
   ```

   The npm version must equal `EXPECTED_VERSION`. The help output must include
   `up`, `verify-url`, `plan-agent`, `explain-run`, `fix`, `apply-repair`,
   `diff`, `registry`, `help`, and `version`.

4. Run explicit-version smoke commands from a fresh directory:

   ```bash
   npx --yes "bootproof@${EXPECTED_VERSION}" up /path/to/local/repository
   npx --yes "bootproof@${EXPECTED_VERSION}" up https://github.com/user/repository
   ```

Do not use a bare cached `npx bootproof` invocation as release verification.
Prefer `bootproof@latest` or the explicit expected version. If npm's local
cache is demonstrably stale, clear it with `npm cache clean --force` and rerun
the explicit-version check.

Remote URL mode accepts credential-free public HTTPS repositories from GitHub, GitLab, Bitbucket, and Codeberg. It retains clones under `.bootproof/remotes/` and requires `--provider local --unsafe-local` before executing remote repository code.

Remote repair follows the same rule:

```bash
npx --yes "bootproof@${EXPECTED_VERSION}" fix https://github.com/user/repository --provider local --unsafe-local
```

`fix` never mutates the source tree. `apply-repair` is the separate explicit application step and refuses invalid signatures, disallowed paths, and stale preimages.

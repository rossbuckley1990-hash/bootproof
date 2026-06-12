# Real Repository Evidence

This document records observed validation outcomes. It is an evidence ledger, not a compatibility matrix.

A detected stack or useful failure class does not mean BootProof fully supports that repository.

## Plane

- Result: `BOOTED`
- Observed: HTTP 200 at `localhost:3000`
- Value: demonstrated an observed web boot with signed proof
- Limitation: proves only the observed web boot, not full platform health

This result comes from prior validation evidence and was not rerun during the June 10, 2026 documentation pass.

## Twenty

- Result: `NOT VERIFIED`
- Class: `postgres_auth_env_missing`
- Value: detected a real database/environment authentication mismatch
- Limitation: BootProof did not repair credentials, edit `.env`, or claim a boot

This result comes from prior validation evidence and was not rerun during the June 10, 2026 documentation pass.

## Documenso

- Result: `NOT VERIFIED`
- Class: `health_http_error`
- Value: services started, dependency installation passed, and the application returned HTTP 500
- Limitation: a running process and responding server were not treated as healthy

This result comes from prior validation evidence and was not rerun during the June 10, 2026 documentation pass.

## Grafana

- Result: `NOT VERIFIED`
- Latest class: `dependency_install_skipped`
- Earlier observed class: `health_check_timeout`
- Value: exposed the need to distinguish the Go backend from the Node/React frontend pipeline and to downrank test plugins
- Current inference: `go-backend`, `node-frontend`, `react`
- Limitation: BootProof detects the hybrid architecture but does not yet orchestrate the full application

The latest local validation ran on June 10, 2026.

## Supabase

- Result: `NOT VERIFIED`
- Historical class: `package_manager_version_mismatch`
- Historical evidence: repository required pnpm 10.24 while the environment had pnpm 9.15.4
- Latest local class: `workspace_ambiguous`
- Value: package-manager mismatch detection is implemented and tested; a matching package manager still does not make a parallel multi-workspace root command a single verifiable app
- Limitation: BootProof requires a specific workspace instead of accepting one responding service as proof for the entire repository

The latest local validation on June 10, 2026 had pnpm 10.24.0, so the historical version mismatch did not reproduce.

## Superset

- Result: `NOT VERIFIED`
- Class: `python_flask_setup_required`
- Value: detected Python/Flask, React frontend, Docker Compose, Celery, migration/init steps, and port 8088
- Limitation: BootProof does not yet orchestrate the database migration, initialization, frontend, worker, and service lifecycle required for verification

The latest local validation ran on June 10, 2026.

## Reading These Results

Useful failure is part of the product:

- `BOOTED` requires an observed health signal.
- `NOT VERIFIED` can still provide a precise diagnosis and signed evidence.
- Detection is not the same as execution support.
- Local proof remains `local_developer_signed`, not enterprise CI/OIDC proof.

## June 11, 2026 Precision Receipts

These runs used fresh shallow clones and did not install dependencies.

### Memos

Command:

```text
node dist/cli.js up /tmp/memos --provider local --unsafe-local --timeout 10000
```

Before (`bootproof@0.1.0`):

```text
application: yes
stack: go-backend, react-frontend
health candidates: http://localhost:3000/
NOT VERIFIED — not_an_application
```

After precision pass (`bootproof@0.2.0`):

```text
application: yes
stack: go-backend, react-frontend
NOT VERIFIED — orchestration_not_supported
Detected go-backend (go.mod) with react-frontend (web/package.json).
Diagnosis only — no localhost claim.
```

Observed result: exit code 1, signed `local_developer_signed` attestation, `booted: false`, `healthVerified: false`, empty observations, and no health candidates. This is diagnosis, not boot support.

After conservative Go orchestration (`bootproof@0.3.0`):

```text
go-modules: dependency preparation completed (exit 0)
start-app: app process started and was supervised
health: observed HTTP 200 at http://localhost:49865/ after 13047ms
BOOTED — HTTP 200 at http://localhost:49865/ (observed, signed)
```

Command:

```text
node dist/cli.js up /tmp/memos-orchestration --provider local --unsafe-local --install --port 49865 --timeout 120000 --ci
```

Observed result on June 11, 2026: exit code 0 and a signed `local_developer_signed` attestation. This proves that the checked-out Memos Go entrypoint served HTTP 200 with its embedded frontend assets. It does not prove every Memos feature, integration, or production configuration.

### Formbricks

Command:

```text
node dist/cli.js analyze /tmp/formbricks
```

Before (`bootproof@0.1.0`):

```text
services: postgres; redis
apps/storybook ranked above apps/web
no repository Compose file reported
```

After (`bootproof@0.3.0`):

```text
repo compose: docker-compose.dev.yml (bootproof defers to it)
compose HTTP services: mailhog (image only); rustfs (image only); hub (image only); cube (image only)
apps/web ranked above apps/storybook
apps/storybook: documentation/storybook downranked
```

`composeFileFor()` returned null, and no `docker-compose.bootproof.yml` was generated. Analysis exited 0; no application boot was attempted or claimed. The selected Compose services use images rather than repository-local build contexts, so their health cannot prove the checked-out Formbricks source. The root `pnpm dev` command is also a parallel multi-workspace pipeline and remains ambiguous without a selected application.

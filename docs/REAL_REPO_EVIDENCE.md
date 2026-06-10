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

# Synthetic External-Orchestrator Fixture

This is a minimal BootProof test description, not a copied Airbyte runbook.

Structural markers represented by this fixture:

- `abctl` manages the documented local deployment.
- Docker provides the local container runtime.
- `kind` provides a local Kubernetes cluster.
- Helm deploys workloads into Kubernetes.
- `/api/v1/health` is the external health route.
- Local UI access may require credentials.
- The repository is a large orchestration repository, not a single local app.

The approved runbook candidate is `abctl local install --port 8001`. Underlying
cluster commands such as `kind create cluster --name bootproof-fixture` and
`helm install fixture chart` are examples of high-risk cluster mutation only.
BootProof must not run any of these commands while planning or in CI.


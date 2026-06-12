# Orchestrated Platform Fixture

This repository requires Java 17 and Gradle. The local deployment uses
Kubernetes, kind, Helm, and abctl.

Run the documented local installer manually:

```bash
abctl local install --port 8001
```

Then inspect deployment status with `abctl local status`.

External health endpoint:
http://localhost:8001/api/v1/health

The browser login requires initial credentials printed by the local setup.

# Airbyte Open Source

Airbyte Open Source is deployed locally with `abctl`, Docker, kind,
Kubernetes, Helm, and NGINX ingress.

```sh
abctl local install --port 8001
abctl local status
abctl local credentials
```

Health endpoints:

- http://localhost:8001/api/v1/health
- http://localhost:8001/api/v1/instance_configuration


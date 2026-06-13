#!/bin/sh

if ! command -v devenv >/dev/null 2>&1; then
  echo "Please install the devenv tool:"
  echo "https://github.com/getsentry/devenv#install"
  exit 1
fi

if [ -z "${VIRTUAL_ENV:-}" ]; then
  echo "Your sentry virtualenv isn't activated. You need to successfully run 'direnv allow'."
  exit 1
fi

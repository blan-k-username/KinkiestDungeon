# Pinned in lockstep with package.json's playwright + @playwright/test versions.
# Bumping one requires bumping the other.
#
# Currently not built by default — tools/run-tests.sh uses the upstream image
# directly. This Dockerfile exists for future CI use (pre-bake project node_modules
# + push to a private registry).
FROM mcr.microsoft.com/playwright:v1.60.0-jammy
WORKDIR /usr/src/app

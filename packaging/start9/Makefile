# Builds the StartOS package (trikey-guardian_x86_64.s9pk, trikey-guardian_aarch64.s9pk).
#
# The build logic ships inside the SDK (node_modules/@start9labs/start-sdk/s9pk.mk), so there
# is nothing to copy. The image is built for linux/amd64 and linux/arm64 only (see
# packaging/docker/Dockerfile), so riscv64 is left out. Overrides must precede the include.
#
# Needs start-cli, Docker, jq, make, Node.js and npm, and a packaging workspace for the
# signing key. See README.md in this folder.
ARCHES := x86 arm
include node_modules/@start9labs/start-sdk/s9pk.mk

#!/usr/bin/env bash
# Print the digests that identify an image in an OCI layout, one line each:
#
#   index    sha256:...                                  (the multi-platform index)
#   platform linux/amd64 manifest sha256:... config sha256:...
#   platform linux/arm64 manifest sha256:... config sha256:...
#
# The manifest digest covers every layer's compressed digest and the config digest;
# the config digest covers the uncompressed layer digests, the environment, the entrypoint
# and the `created` time. If two builds print the same lines, the two images are the same
# bytes. Same lines in, same image out: this is what reproducible.yml and
# packaging/VERIFY.md compare.
#
# Usage: oci-digests.sh IMAGE.tar     (docker buildx build --output type=oci,dest=IMAGE.tar)
#        oci-digests.sh LAYOUT_DIR    (an unpacked OCI image layout)
# Needs: bash, tar, jq.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 IMAGE.tar|LAYOUT_DIR" >&2
  exit 2
fi

src=$1
if [ -d "$src" ]; then
  layout=$src
else
  layout=$(mktemp -d)
  trap 'rm -rf "$layout"' EXIT
  tar -xf "$src" -C "$layout"
fi

blob() { # sha256:abc... -> path of the blob in the layout
  local algo=${1%%:*} hex=${1#*:}
  printf '%s/blobs/%s/%s' "$layout" "$algo" "$hex"
}

# A blob is only as good as its name: check that the content hashes to its digest, so
# a damaged or tampered archive fails here and not as a confusing diff later.
check() {
  local want=$1 got
  got=$(sha256sum "$(blob "$want")" | cut -d' ' -f1)
  if [ "sha256:$got" != "$want" ]; then
    echo "blob $want does not match its content (sha256:$got)" >&2
    exit 1
  fi
}

# Print a manifest (an image for one platform). Arguments: digest, os/arch from the index
# entry (may be empty, then the config says).
print_manifest() {
  local digest=$1 platform=$2 config
  check "$digest"
  config=$(jq -r '.config.digest' "$(blob "$digest")")
  check "$config"
  if [ -z "$platform" ]; then
    platform=$(jq -r '"\(.os)/\(.architecture)" + (if .variant then "/\(.variant)" else "" end)' "$(blob "$config")")
  fi
  echo "platform $platform manifest $digest config $config"
}

# Walk the index. Attestation manifests (os "unknown") are skipped: they describe the
# build, not the image, and carry build-specific data.
walk() {
  local digest=$1 media
  check "$digest"
  media=$(jq -r '.mediaType // empty' "$(blob "$digest")")
  case $media in
    application/vnd.oci.image.index.v1+json | application/vnd.docker.distribution.manifest.list.v2+json)
      echo "index    $digest"
      jq -r '.manifests[]
             | select((.platform.os // "") != "unknown")
             | "\(.digest) \(.platform.os)/\(.platform.architecture)" + (if .platform.variant then "/\(.platform.variant)" else "" end)' \
        "$(blob "$digest")" | sort -k2 | while read -r child platform; do
          print_manifest "$child" "$platform"
        done
      ;;
    application/vnd.oci.image.manifest.v1+json | application/vnd.docker.distribution.manifest.v2+json)
      print_manifest "$digest" ""
      ;;
    *)
      echo "unexpected media type '$media' for $digest" >&2
      exit 1
      ;;
  esac
}

if [ ! -f "$layout/index.json" ]; then
  echo "$src is not an OCI layout (no index.json)" >&2
  exit 1
fi

count=$(jq '.manifests | length' "$layout/index.json")
if [ "$count" -ne 1 ]; then
  echo "expected exactly one image in index.json, found $count" >&2
  exit 1
fi
walk "$(jq -r '.manifests[0].digest' "$layout/index.json")"

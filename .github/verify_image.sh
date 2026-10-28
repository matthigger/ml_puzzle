#!/usr/bin/env bash
# Print the prebuilt re-run image for the puzzle whose folder this runs in,
# e.g. ghcr.io/matthigger/ml_puzzle/slice_crawl-verify:<tag>. The tag hashes
# every file the image is built from, so a pulled image always matches the
# checkout: change one and the tag changes (image.yml builds the new one).
set -euo pipefail
puzzle=$(basename "$PWD")
tag=$(git ls-files -s -- py verify/Dockerfile verify/child.py \
      | sha256sum | cut -c1-16)
echo "ghcr.io/matthigger/ml_puzzle/${puzzle}-verify:${tag}"

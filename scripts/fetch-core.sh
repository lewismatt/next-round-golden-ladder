#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Fetch the Next Round platform packages this module builds against.
# The platform packages (@next-round/contracts, game-sdk, game-client) are
# workspace packages in lewismatt/next-round and are not published to a
# registry; development here links them from a pinned checkout in .core/.
set -eu
CORE_REF="${CORE_REF:-8fcb2ca842430f764012f2b14599f3efb2a87edf}"
CORE_URL="${CORE_URL:-https://github.com/lewismatt/next-round.git}"
cd "$(dirname "$0")/.."
if [ ! -d .core/.git ]; then
  rm -rf .core
  git clone --quiet "$CORE_URL" .core
fi
git -C .core fetch --quiet origin "$CORE_REF" 2>/dev/null || git -C .core fetch --quiet origin
git -C .core checkout --quiet "$CORE_REF"
echo "core pinned at $(git -C .core rev-parse HEAD)"

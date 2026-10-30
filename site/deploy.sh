#!/bin/sh
# Puts site/public live at browserbear.mikecann.app (a Cloudflare Worker on Mike's account), with
# a pinned wrangler so a broken global install can't stop a deploy. The privacy page is
# built from ../PRIVACY.md by hand for now: update both together.
set -eu
cd "$(dirname "$0")"
W=.wrangler-cli/node_modules/.bin/wrangler
[ -x "$W" ] || npm i --silent --no-audit --no-fund --prefix .wrangler-cli wrangler@4.112.0
"$W" deploy

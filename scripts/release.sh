#!/bin/sh
# annai-release [commit]: unpacks a commit of the annai repository into its own release folder, writes the
# brotli forms of its shipped files beside them (scripts/build-release.mjs, the release's own copy; a
# commit older than that script is served as it is), switches the "current" link to it, restarts the site
# and the relay (whose waiting reminders are in /var/lib/annai-relay and survive), and keeps the last 5
# releases. It stops before switching when an official plugin changed under a version already released.
# /usr/local/sbin/annai-release is a link to this file.
set -eu
REPO=/mnt/optane/work/annai
R=/mnt/klein/deploy/annai
c=$(git -C "$REPO" rev-parse --short "${1:-main}")
if [ ! -d "$R/releases/$c" ]; then
  rm -rf -- "${R:?}/releases/$c.tmp"
  mkdir -p "$R/releases/$c.tmp"
  git -C "$REPO" archive "$c" | tar -x -C "$R/releases/$c.tmp"
  if [ -f "$R/releases/$c.tmp/scripts/build-release.mjs" ]; then
    node "$R/releases/$c.tmp/scripts/build-release.mjs" "$R/releases/$c.tmp"
  fi
  mv -f -T "$R/releases/$c.tmp" "$R/releases/$c"
fi
# An official plugin whose files changed under a version already released would read as a changed copy on a phone that has
# it: such a release stops here, naming the plugins to give new versions (the release's own scripts/catalog-versions.mjs).
if [ -f "$R/releases/$c/scripts/catalog-versions.mjs" ] && [ -f "$R/current/catalog/plugins.json" ]; then
  node "$R/releases/$c/scripts/catalog-versions.mjs" "$R/current/catalog/plugins.json" "$R/releases/$c/catalog/plugins.json" \
    || { echo "annai.guide still serves $(basename "$(readlink "$R/current")"): give those plugins new versions, then release again" >&2; exit 1; }
fi
ln -sfn "releases/$c" "$R/current.new"
mv -f -T "$R/current.new" "$R/current"
systemctl restart annai-site annai-relay
ls -1t "$R/releases" | tail -n +6 | while read -r d; do
  [ "$d" = "$c" ] || rm -rf -- "${R:?}/releases/${d:?}"
done
echo "annai.guide now serves $c"

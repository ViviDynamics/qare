#!/bin/sh
# Exercise the release installer against its published image from a new checkout.
set -eu
installer=$(cd "$(dirname "$0")" && pwd)/install.sh
release=${1:?pass the expected release tag}
sample=$(mktemp -d)
trap 'rm -rf "$sample"' EXIT
mkdir "$sample/repo"
cd "$sample/repo"
git init -q
printf '%s\n' 'services:' '  web:' '    image: nginx' '    ports: ["8080:80"]' > compose.yml
sh "$installer" </dev/null > "../first.log"
grep -F '# QARE readiness report' "../first.log"
grep -F 'gh secret set OPENAI_API_KEY' "../first.log"
grep -F 'Closes #' "../first.log"
workflow=.github/workflows/qare.yml
grep -Fx "    uses: ViviDynamics/qare/.github/workflows/pipeline.yml@$release" "$workflow"
printf '\n# kept local settings\n' >> .qa/config.yml
printf '\n# kept local caller\n' >> "$workflow"
cp -R .qa "../saved-profile"
cp "$workflow" "../saved-workflow"
sh "$installer" </dev/null > "../repeat.log"
grep -F '# QARE readiness report' "../repeat.log"
diff -r "../saved-profile" .qa
cmp "../saved-workflow" "$workflow"

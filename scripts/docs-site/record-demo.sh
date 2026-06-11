#!/bin/sh
# Regenerates docs/assets/flow-demo.gif from the committed tape using the
# locally built CLI. Requires vhs (https://github.com/charmbracelet/vhs).
set -e
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
demo_dir="$(mktemp -d /tmp/flow-vhs-demo.XXXXXX)"
mkdir -p "$demo_dir/bin"
printf '#!/bin/sh\nexec "%s" "%s/dist/cli.js" "$@"\n' "$(command -v node)" "$repo_root" > "$demo_dir/bin/flow"
chmod +x "$demo_dir/bin/flow"
cd "$repo_root"
npm run build --silent
FLOW_DEMO_DIR="$demo_dir" PATH="$demo_dir/bin:$PATH" vhs scripts/docs-site/flow-demo.tape
rm -rf "$demo_dir"
echo "regenerated docs/assets/flow-demo.gif"

/** Activate the selected repository's declared tool versions and Rust components. */
export const sourceDeclaredToolchainActivationCommand = (): string => String.raw`set -euo pipefail
config_file="$PWD/.config/mise/config.toml"
runtime_bin="$(dirname "$(command -v bun)")"
test -f "$config_file"
test -x "$runtime_bin/bun"
export MISE_CONFIG_FILE="$config_file"
mise trust --yes "$config_file"
mise install --locked cue rust
cue_bin="$(mise which cue)"
test -x "$cue_bin"
ln -sfn "$cue_bin" "$runtime_bin/cue"
"$runtime_bin/cue" version >/dev/null`;

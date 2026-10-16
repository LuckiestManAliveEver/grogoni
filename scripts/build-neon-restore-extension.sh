#!/usr/bin/env bash
set -euo pipefail

# Build only upstream code in the separate, secret-free job. Cache no database data.
source_commit=937a79a65e596d916295d078b3a82ab421291665
destination=/grogoni-restore-extensions
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --no-install-recommends -y ca-certificates curl git build-essential clang libclang-dev libssl-dev pkg-config postgresql-server-dev-18
curl --proto '=https' --tlsv1.2 --fail --silent --show-error https://sh.rustup.rs -o "$temporary/rustup.sh"
sh "$temporary/rustup.sh" -y --profile minimal --default-toolchain 1.90.0
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_BUILD_JOBS=2
cargo install --locked --version 0.16.1 cargo-pgrx
cargo pgrx init --pg18 /usr/lib/postgresql/18/bin/pg_config
git init "$temporary/source"
git -C "$temporary/source" fetch --depth 1 https://github.com/neondatabase/pg_session_jwt.git "$source_commit"
git -C "$temporary/source" checkout --detach FETCH_HEAD
test "$(git -C "$temporary/source" rev-parse HEAD)" = "$source_commit"
cd "$temporary/source"
cargo pgrx package --locked --pg-config /usr/lib/postgresql/18/bin/pg_config --no-default-features --features pg18 --out-dir "$temporary/package"
library=$(find "$temporary/package" -type f -name pg_session_jwt.so -print -quit)
control=$(find "$temporary/package" -type f -name pg_session_jwt.control -print -quit)
test -s "$library"
test -s "$control"
mkdir -p "$destination/lib" "$destination/share/extension"
cp "$library" "$destination/lib/pg_session_jwt.so"
cp "$(dirname "$control")"/* "$destination/share/extension/"
for file in "$destination/share/extension/"*.control "$destination/share/extension/"*.sql; do
  sed -i 's|[$]libdir/pg_session_jwt|/grogoni-restore-extensions/lib/pg_session_jwt|g' "$file"
done
printf '%s\n' "$source_commit" > "$destination/source-commit"
test -s "$destination/share/extension/pg_session_jwt--0.5.0.sql"

#!/bin/sh

main() {
  set -eu
  umask 077
  repository='https://github.com/klinamen/cutegantt'
  version=''
  install_dir=''
  temporary=''
  staging=''

  fail() {
    printf 'cutegantt installer: %s\n' "$*" >&2
    exit 1
  }

  cleanup() {
    if [ -n "$staging" ]; then rm -rf "$staging"; fi
    if [ -n "$temporary" ]; then rm -rf "$temporary"; fi
  }

  download() {
    curl -q --fail --silent --show-error --location \
      --proto '=https' --proto-redir '=https' \
      --retry 2 --connect-timeout 15 --max-time 300 "$@"
  }

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version|--dir)
        [ "$#" -ge 2 ] && [ -n "$2" ] || fail "Missing value for $1"
        case "$1" in
          --version) version=$2 ;;
          --dir) install_dir=$2 ;;
        esac
        shift 2
        ;;
      -h|--help)
        printf '%s\n' \
          'Usage: sh install.sh [--version TAG] [--dir DIRECTORY]' \
          'Default: latest stable release, installed into $HOME/.local/bin.' \
          'Supports macOS and Linux (glibc), x64 and ARM64. No sudo or Node required.'
        return 0
        ;;
      *) fail "Unknown option: $1" ;;
    esac
  done

  if [ -z "$install_dir" ]; then
    [ -n "${HOME:-}" ] || fail 'HOME is unset; specify --dir.'
    install_dir=$HOME/.local/bin
  fi
  case "$install_dir" in
    /*) ;;
    *) install_dir=$PWD/$install_dir ;;
  esac

  for command in curl uname tar mktemp mkdir chmod mv rm; do
    command -v "$command" >/dev/null 2>&1 || fail "Required command not found: $command"
  done
  system=$(uname -s)
  case "$system" in
    Darwin) platform=darwin ;;
    Linux)
      platform=linux
      libc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || fail 'Linux requires glibc; Alpine/musl is not supported.'
      case "$libc" in glibc\ *) ;; *) fail 'Unable to identify a supported glibc runtime.' ;; esac
      ;;
    *) fail "Unsupported operating system: $system" ;;
  esac
  machine=$(uname -m)
  case "$machine" in
    x86_64|amd64) architecture=x64 ;;
    arm64|aarch64) architecture=arm64 ;;
    *) fail "Unsupported architecture: $machine" ;;
  esac
  if command -v sha256sum >/dev/null 2>&1; then
    checksum_tool=sha256sum
  elif command -v shasum >/dev/null 2>&1; then
    checksum_tool=shasum
  else
    fail 'SHA-256 verification requires sha256sum or shasum.'
  fi

  if [ -z "$version" ]; then
    release_url=$(download --head --output /dev/null --write-out '%{url_effective}' "$repository/releases/latest") \
      || fail 'Cannot resolve the latest release; try --version TAG.'
    case "$release_url" in
      "$repository/releases/tag/"*) version=${release_url##*/} ;;
      *) fail 'GitHub did not return a release tag.' ;;
    esac
  fi
  case "$version" in
    ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) fail 'Invalid release tag; use letters, digits, dots, underscores and hyphens.' ;;
  esac

  trap cleanup 0
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  temporary=$(mktemp -d "${TMPDIR:-/tmp}/cutegantt-install.XXXXXX")
  filename=cutegantt-$platform-$architecture.tar.gz
  base=$repository/releases/download/$version
  printf 'Downloading CuteGantt %s (%s-%s)...\n' "$version" "$platform" "$architecture"
  download --output "$temporary/$filename" "$base/$filename" \
    || fail 'Binary unavailable. Release assets may still be building; retry later. Existing installation unchanged.'
  download --output "$temporary/$filename.sha256" "$base/$filename.sha256" \
    || fail 'Checksum unavailable; refusing installation.'
  expected='' checksum_name='' extra=''
  read -r expected checksum_name extra < "$temporary/$filename.sha256" || fail 'Malformed checksum file.'
  [ "${#expected}" -eq 64 ] || fail 'Invalid SHA-256 checksum length.'
  case "$expected" in *[!0-9a-f]*) fail 'Invalid SHA-256 checksum.' ;; esac
  [ "$checksum_name" = "$filename" ] && [ -z "$extra" ] || fail 'Checksum filename mismatch.'
  if [ "$checksum_tool" = sha256sum ]; then
    actual=$(sha256sum "$temporary/$filename")
  else
    actual=$(shasum -a 256 "$temporary/$filename")
  fi
  [ "${actual%% *}" = "$expected" ] || fail 'SHA-256 mismatch; existing installation unchanged.'

  entries=$(tar -tzf "$temporary/$filename") || fail 'Invalid release archive.'
  [ "$entries" = cutegantt ] || fail 'Archive must contain only the cutegantt executable.'
  mkdir -p "$install_dir"
  install_dir=$(cd "$install_dir" && pwd -P)
  destination=$install_dir/cutegantt
  [ ! -d "$destination" ] && [ ! -L "$destination" ] || fail 'Destination is a directory or symlink; refusing to replace it.'
  staging=$(mktemp -d "$install_dir/.cutegantt.XXXXXX")
  tar -xOzf "$temporary/$filename" cutegantt > "$staging/cutegantt" || fail 'Cannot extract executable.'
  [ -s "$staging/cutegantt" ] || fail 'Archive contains no executable data.'
  chmod 755 "$staging/cutegantt"
  if ! "$staging/cutegantt" --help > "$temporary/runtime.log" 2>&1; then
    fail 'Binary cannot run on this system. Check OS/glibc compatibility. Existing installation unchanged.'
  fi
  mv -f "$staging/cutegantt" "$destination"
  printf 'Installed CuteGantt %s to %s\n' "$version" "$destination"
  case ":${PATH:-}:" in
    *:"$install_dir":*) ;;
    *) printf 'Add this directory to your shell PATH: %s\n' "$install_dir" ;;
  esac
}

main "$@"
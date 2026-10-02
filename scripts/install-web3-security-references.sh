#!/usr/bin/env bash
set -euo pipefail
base_dir="${HOME}/web3-security-references"
repos=(
  "learn-evm-attacks|https://github.com/coinspect/learn-evm-attacks.git"
  "SCV-List|https://github.com/sirhashalot/SCV-List.git"
  "smart-contract-attack-vectors|https://github.com/harendra-shakya/smart-contract-attack-vectors.git"
  "DeFi-Attack-Vectors|https://github.com/Quillhash/DeFi-Attack-Vectors.git"
  "smart-contract-vulnerabilities|https://github.com/kadenzipfel/smart-contract-vulnerabilities.git"
  "DeFiHackLabs|https://github.com/SunWeb3Sec/DeFiHackLabs.git"
  "SCSVS|https://github.com/securing/SCSVS.git"
  "solcurity|https://github.com/transmissions11/solcurity.git"
  "Web3-Security-Library|https://github.com/immunefi-team/Web3-Security-Library.git"
)
usage() {
  printf '%s\n' 'Usage: install-web3-security-references.sh [--base-dir PATH] NAME...' \
    '       install-web3-security-references.sh --list' \
    'Use --all explicitly to select every reference. No selection downloads nothing.'
}
selected=()
while (($#)); do
  case "$1" in
    --base-dir)
      (($# >= 2)) || { usage >&2; exit 2; }
      base_dir="$2"; shift 2 ;;
    --all)
      for item in "${repos[@]}"; do selected+=("${item%%|*}"); done
      shift ;;
    --list|--help|-h)
      usage
      for item in "${repos[@]}"; do printf '%s\n' "${item%%|*}"; done
      exit 0 ;;
    --*) usage >&2; exit 2 ;;
    *) selected+=("$1"); shift ;;
  esac
 done
((${#selected[@]})) || { usage; exit 0; }
# Validate every selection before creating directories or downloading anything.
for name in "${selected[@]}"; do
  found=false
  for item in "${repos[@]}"; do [[ "$name" == "${item%%|*}" ]] && found=true; done
  "$found" || { printf 'Unknown reference: %s\n' "$name" >&2; exit 2; }
done
repos_dir="$base_dir/repos"
mkdir -p "$repos_dir"
for name in "${selected[@]}"; do
  for item in "${repos[@]}"; do
    [[ "$name" == "${item%%|*}" ]] || continue
    url="${item#*|}"
    dest="$repos_dir/$name"
    if [[ -L "$dest" || -L "$dest/.git" ]]; then
      printf '[skip] %s: linked checkout\n' "$name"; continue
    fi
    if [[ -d "$dest/.git" ]]; then
      origin="$(git -C "$dest" remote get-url origin)"
      if [[ "$origin" != "$url" ]] || [[ -n "$(git -C "$dest" status --porcelain)" ]]; then
        printf '[skip] %s: different origin or local changes\n' "$name"; continue
      fi
      branch="$(git -C "$dest" symbolic-ref --quiet --short HEAD || true)"
      default_ref="$(git -C "$dest" symbolic-ref --quiet --short refs/remotes/origin/HEAD || true)"
      if [[ -z "$branch" || "$branch" != "${default_ref#origin/}" ]]; then
        printf '[skip] %s: detached or non-default branch\n' "$name"; continue
      fi
      printf '[update] %s\n' "$name"
      git -C "$dest" fetch --deepen=20 origin "$branch"
      if ! git -C "$dest" merge --ff-only "origin/$branch"; then
        printf '[skip] %s: update needs manual review\n' "$name" >&2
      fi
    elif [[ -e "$dest" ]]; then
      printf '[skip] %s: destination already exists\n' "$name"
    else
      printf '[clone] %s\n' "$name"
      git clone --depth 1 "$url" "$dest"
    fi
  done
done
printf 'Selected references are under %s\n' "$repos_dir"

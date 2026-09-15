#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: scripts/compare-images.sh [--baseline <sha>] [--out <dir>]\n' >&2
  exit 2
}

log() {
  printf 'compare-images: %s\n' "$*" >&2
}

die() {
  printf 'compare-images: %s\n' "$*" >&2
  exit 1
}

baseline_ref=
out=
while [ $# -gt 0 ]; do
  case $1 in
    --baseline) { [ $# -ge 2 ] && [ -n "$2" ]; } || usage; baseline_ref=$2; shift 2 ;;
    --out) { [ $# -ge 2 ] && [ -n "$2" ]; } || usage; out=$2; shift 2 ;;
    *) usage ;;
  esac
done

if [ -z "$out" ]; then
  out=$(mktemp -d "${TMPDIR:-/tmp}/compare-images-out.XXXXXX")
fi
mkdir -p "$out"
out=$(cd "$out" && pwd -P)

root=$(git rev-parse --show-toplevel)
cd "$root"

if [ -z "$baseline_ref" ]; then
  baseline_ref=$(git merge-base HEAD origin/dev)
fi
baseline=$(git rev-parse --verify --quiet "$baseline_ref^{commit}") || { log "not a commit: $baseline_ref"; exit 2; }

baseline_image=trafegodns:ts-baseline
candidate_image=trafegodns:ts-candidate
work=$(mktemp -d "${TMPDIR:-/tmp}/compare-images.XXXXXX")
work=$(cd "$work" && pwd -P)
container=

cleanup() {
  if [ -n "$container" ]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  if [ -d "$work/baseline" ]; then
    git worktree remove --force "$work/baseline" >/dev/null 2>&1 || true
  fi
  git worktree prune >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

rm -rf "$out/content" "$out/scenarios" "$out/summary.md" "$out/diffs.txt" "$out/build-baseline.log" "$out/build-candidate.log"
mkdir -p "$out/content" "$out/scenarios"
: >"$out/diffs.txt"
failed=0

log "building dist/"
npm run --silent build >&2

log "adding the baseline worktree at $baseline"
git worktree add --quiet --detach "$work/baseline" "$baseline"

log "building $baseline_image with the baseline's own Dockerfile (log: $out/build-baseline.log)"
if ! docker build --progress=plain -f "$work/baseline/docker-s6/Dockerfile" -t "$baseline_image" "$work/baseline" >"$out/build-baseline.log" 2>&1; then
  tail -n 40 "$out/build-baseline.log" >&2
  die "docker build failed for $baseline_image"
fi

log "building $candidate_image from the working tree (log: $out/build-candidate.log)"
if ! docker build --progress=plain -f docker-s6/Dockerfile -t "$candidate_image" . >"$out/build-candidate.log" 2>&1; then
  tail -n 40 "$out/build-candidate.log" >&2
  die "docker build failed for $candidate_image"
fi

record_diff() {
  local title=$1 left=$2 right=$3
  {
    printf '### %s\n' "$title"
    diff -u "$left" "$right" || true
    printf '\n'
  } >>"$out/diffs.txt"
}

content_rows=
content_check() {
  local name=$1 label=$2 cmd=$3 result
  log "content check: $label"
  docker run --rm --network none --entrypoint sh "$baseline_image" -c "$cmd" >"$out/content/$name.baseline" || die "content check $name failed to run ($baseline_image)"
  docker run --rm --network none --entrypoint sh "$candidate_image" -c "$cmd" >"$out/content/$name.candidate" || die "content check $name failed to run ($candidate_image)"
  { [ -s "$out/content/$name.baseline" ] && [ -s "$out/content/$name.candidate" ]; } || die "content check $name produced no output"
  if cmp -s "$out/content/$name.baseline" "$out/content/$name.candidate"; then
    result=PASS
  else
    result=FAIL
    failed=1
    record_diff "content: $label" "$out/content/$name.baseline" "$out/content/$name.candidate"
  fi
  content_rows="$content_rows| $label | $result |"$'\n'
}

content_check app-files '`/app` file list, excluding `node_modules`' 'cd /app && find . -path ./node_modules -prune -o -print | sort'
content_check node-modules '`/app/node_modules` hash' 'cd /app/node_modules && find . -type f -exec sha256sum {} + | sort | sha256sum'
content_check s6-scripts '`/etc/cont-init.d/*`, `/etc/services.d/trafegodns/*` hashes' 'sha256sum /etc/cont-init.d/* /etc/services.d/trafegodns/*'

log 'content check: candidate /app/src against the local dist/src'
container=$(docker create "$candidate_image")
docker cp "$container:/app/src" "$work/candidate-src" >/dev/null 2>"$work/docker-cp.log" || { cat "$work/docker-cp.log" >&2; die "docker cp failed"; }
docker rm "$container" >/dev/null
container=
if node dist/scripts/migration-check.js compare-dirs "$work/candidate-src" dist/src >"$out/content/candidate-src.compare-dirs" 2>&1; then
  result=PASS
else
  result=FAIL
  failed=1
  {
    printf '### content: candidate /app/src against the local dist/src\n'
    cat "$out/content/candidate-src.compare-dirs"
    printf '\n'
  } >>"$out/diffs.txt"
fi
content_rows="$content_rows| Candidate \`/app/src/**/*.js\` against the local \`dist/src/**/*.js\` | $result ($(tail -n 1 "$out/content/candidate-src.compare-dirs")) |"$'\n'

scenario_label() {
  case $1 in
    S1) printf 'S1 Cloudflare, traefik mode' ;;
    S2) printf 'S2 DigitalOcean' ;;
    S3) printf 'S3 Route53' ;;
    S4) printf 'S4 Direct mode' ;;
    S5) printf 'S5 Missing token' ;;
    S6) printf 'S6 Unsupported provider' ;;
    S7) printf 'S7 Missing secret file' ;;
    S8) printf 'S8 TRACE logging, `api.cloudflare.com` → `127.0.0.1`' ;;
    S9) printf 'S9 Through s6' ;;
  esac
}

flags=()
scenario_flags() {
  local level=INFO
  case $1 in
    S1|S9) flags=(-e CLOUDFLARE_TOKEN=SYNTHETIC -e CLOUDFLARE_ZONE=example.com) ;;
    S2) flags=(-e DNS_PROVIDER=digitalocean -e DO_TOKEN=SYNTHETIC -e DO_DOMAIN=example.com) ;;
    S3) flags=(-e DNS_PROVIDER=route53 -e ROUTE53_ACCESS_KEY=SYNTHETIC -e ROUTE53_SECRET_KEY=SYNTHETIC -e ROUTE53_ZONE=example.com) ;;
    S4) flags=(-e CLOUDFLARE_TOKEN=SYNTHETIC -e CLOUDFLARE_ZONE=example.com -e OPERATION_MODE=direct) ;;
    S5) flags=(-e CLOUDFLARE_ZONE=example.com) ;;
    S6) flags=(-e DNS_PROVIDER=bogus) ;;
    S7) flags=(-e CLOUDFLARE_TOKEN_FILE=/nonexistent -e CLOUDFLARE_ZONE=example.com) ;;
    S8) flags=(--add-host api.cloudflare.com:127.0.0.1 -e CLOUDFLARE_TOKEN=SYNTHETIC -e CLOUDFLARE_ZONE=example.com); level=TRACE ;;
    *) die "unknown scenario $1" ;;
  esac
  flags=(-e PUBLIC_IP=192.0.2.10 -e PUBLIC_IPV6=2001:db8::10 -e "LOG_LEVEL=$level" -e TRAEFIK_API_URL=http://127.0.0.1:1/api ${flags[@]+"${flags[@]}"})
}

run_scenario() {
  local image=$1 dir=$2 mode=$3 name="ts-compare-$$-$RANDOM" limit=90 waited=0 running
  shift 3
  mkdir -p "$dir"
  container=$name
  if [ "$mode" = node ]; then
    docker run -d --name "$name" --network none --entrypoint node -w /app "$@" "$image" src/app.js >/dev/null
  else
    limit=15
    docker run -d --name "$name" --network none "$@" "$image" >/dev/null
  fi
  while [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ] && [ "$waited" -lt "$limit" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  running=$(docker inspect -f '{{.State.Running}}' "$name")
  docker kill "$name" >/dev/null 2>&1 || true
  if [ "$mode" = node ]; then
    docker logs "$name" >"$dir/stdout" 2>"$dir/stderr"
    if [ "$running" = true ]; then echo timeout; else docker inspect -f '{{.State.ExitCode}}' "$name"; fi >"$dir/exit"
  else
    docker logs "$name" >"$dir/combined" 2>&1
    awk '{ print } /has exited with status/ { exit }' "$dir/combined" >"$dir/stdout"
    : >"$dir/stderr"
    echo n/a >"$dir/exit"
  fi
  docker rm -f "$name" >/dev/null
  container=
}

guard() {
  local id=$1 image=$2 dir=$3 mode=$4
  if [ "$mode" = node ]; then
    { grep -q 'Logger initialised with level:' "$dir/stdout" && grep -Eqx '[0-9]+|timeout' "$dir/exit"; } || die "scenario $id did not run ($image)"
  else
    grep -q 'has exited with status' "$dir/stdout" || die "scenario $id did not run ($image)"
  fi
}

normalise() {
  perl -pe 's/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/<ts>/g; s/\b\d+ ms\b/<n> ms/g; s/\.js:\d+:\d+/.js:<l>:<c>/g' "$1" >"$2"
}

stream_result=
racy=
compare_stream() {
  local id=$1 d=$2 s=$3
  if cmp -s "$d/b1/$s.norm" "$d/b2/$s.norm"; then
    if cmp -s "$d/b1/$s.norm" "$d/c/$s.norm"; then
      stream_result=PASS
    else
      stream_result=FAIL
      record_diff "$id $s (baseline b1 vs candidate, normalised)" "$d/b1/$s.norm" "$d/c/$s.norm"
    fi
  elif [ "$s" = exit ]; then
    stream_result='FAIL (baseline exit unstable)'
    record_diff "$id exit (baseline b1 vs baseline b2)" "$d/b1/exit.norm" "$d/b2/exit.norm"
  else
    racy="$racy $s"
    LC_ALL=C sort "$d/b1/$s.norm" >"$d/b1/$s.sorted"
    LC_ALL=C sort "$d/c/$s.norm" >"$d/c/$s.sorted"
    if cmp -s "$d/b1/$s.sorted" "$d/c/$s.sorted"; then
      stream_result='PASS (sorted)'
    else
      stream_result='FAIL (sorted)'
      record_diff "$id $s (baseline b1 vs candidate, normalised and sorted)" "$d/b1/$s.sorted" "$d/c/$s.sorted"
    fi
  fi
}

scenario_rows=
for id in S1 S2 S3 S4 S5 S6 S7 S8 S9; do
  mode=node
  if [ "$id" = S9 ]; then mode=s6; fi
  scenario_flags "$id"
  sdir="$out/scenarios/$id"
  for run in b1 b2 c; do
    image=$baseline_image
    if [ "$run" = c ]; then image=$candidate_image; fi
    started=$(date +%s)
    run_scenario "$image" "$sdir/$run" "$mode" "${flags[@]}"
    guard "$id" "$image" "$sdir/$run" "$mode"
    for s in stdout stderr exit; do
      normalise "$sdir/$run/$s" "$sdir/$run/$s.norm"
    done
    log "$id $run ($image): exit $(cat "$sdir/$run/exit"), $(($(date +%s) - started)) s"
  done
  racy=
  row_result=PASS
  cells=
  for s in stdout stderr exit; do
    compare_stream "$id" "$sdir" "$s"
    case $stream_result in
      PASS*) ;;
      *) row_result=FAIL; failed=1 ;;
    esac
    if [ "$s" = exit ]; then stream_result="$stream_result ($(cat "$sdir/c/exit"))"; fi
    cells="$cells $stream_result |"
  done
  control=stable
  if [ -n "$racy" ]; then control="racy (sorted):$racy"; fi
  scenario_rows="$scenario_rows| $(scenario_label "$id") | $control |$cells $row_result |"$'\n'
done

overall=PASS
if [ "$failed" -ne 0 ]; then overall=FAIL; fi
dirty=$(git status --porcelain | wc -l | tr -d ' ')

{
  printf '# Image and boot comparison\n\n'
  printf -- '- Baseline: `%s` (`%s`, image `%s`)\n' "$baseline" "$baseline_image" "$(docker image inspect -f '{{.Id}}' "$baseline_image")"
  printf -- '- Candidate: working tree at `%s`, %s uncommitted paths (`%s`, image `%s`)\n' "$(git rev-parse HEAD)" "$dirty" "$candidate_image" "$(docker image inspect -f '{{.Id}}' "$candidate_image")"
  printf '\n## Content checks\n\n'
  printf '| Check | Result |\n|---|---|\n'
  printf '%s' "$content_rows"
  printf '\n## Boot scenarios\n\n'
  printf '| Scenario | Control | stdout | stderr | exit | Result |\n|---|---|---|---|---|---|\n'
  printf '%s' "$scenario_rows"
  printf '\nResult: %s\n' "$overall"
} >"$out/summary.md"

cat "$out/summary.md"
if [ "$failed" -ne 0 ]; then
  printf '\n'
  cat "$out/diffs.txt"
  exit 1
fi

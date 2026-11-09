#!/usr/bin/env bash
# Finds a release build's run for the tag this workflow runs on, by commit: the runs of <workflow> whose head_sha is
# GITHUB_SHA (the tag's commit; release tags cannot be moved) and that a push or a dispatch started. Never by name:
# `gh run list --branch <tag>` matches head_branch, which a run on a branch named like the tag has too.
#
# A run on a branch at the same commit runs the same workflow file, in which <job> runs only on a v* tag ref
# (docker.yml's `verified`, android-apk.yml's `release`). So a run is the tag's only if <job> ran in it.
#
#   release-run.sh newest <workflow> <job>
#     The newest run of the tag, as "<id> <status> <conclusion> <url>" (tab-separated), or nothing when there is none
#     yet. A run that succeeded without <job> succeeding is not the tag's and is passed over.
#   release-run.sh verified <workflow> <job>
#     The newest run in which <job> succeeded, as "<id> <url>"; fails when there is none.
#
# Environment: GITHUB_REPOSITORY, GITHUB_SHA, GH_TOKEN (actions: read).
set -euo pipefail
mode="${1:?newest or verified}" wf="${2:?workflow file}" job="${3:?job name}"
: "${GITHUB_REPOSITORY:?}" "${GITHUB_SHA:?}"
[[ "${GITHUB_SHA}" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::not a commit: ${GITHUB_SHA}" >&2; exit 1; }
[[ "${wf}" =~ ^[a-z0-9-]+\.yml$ ]] || { echo "::error::not a workflow file: ${wf}" >&2; exit 1; }

# Newest first: id, status, conclusion, url.
runs() {
  gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/${wf}/runs?head_sha=${GITHUB_SHA}&per_page=100" \
    --jq "[.workflow_runs[] | select(.head_sha == \"${GITHUB_SHA}\" and (.event == \"push\" or .event == \"workflow_dispatch\"))]
      | sort_by(.id) | reverse | .[] | [.id, .status, (.conclusion // \"none\"), .html_url] | @tsv"
}
# How <job> ended in a run (its latest attempt): success, failure, skipped, ..., or "missing".
job_result() {
  gh api "repos/${GITHUB_REPOSITORY}/actions/runs/$1/jobs?filter=latest&per_page=100" \
    --jq "[.jobs[] | select(.name == \"${job}\") | (.conclusion // .status)] | first // \"missing\""
}

while IFS=$'\t' read -r id status conclusion url; do
  [ -n "${id}" ] || continue
  case "${mode}" in
    newest)
      if [ "${status}" = completed ] && [ "${conclusion}" = success ] && [ "$(job_result "${id}")" != success ]; then
        echo "Run ${url} succeeded without ${job}: not the tag's run (a branch at the same commit?); passed over." >&2
        continue
      fi
      printf '%s\t%s\t%s\t%s\n' "${id}" "${status}" "${conclusion}" "${url}"
      exit 0
      ;;
    verified)
      if [ "$(job_result "${id}")" = success ]; then
        printf '%s\t%s\n' "${id}" "${url}"
        exit 0
      fi
      ;;
    *)
      echo "::error::unknown mode ${mode}" >&2
      exit 1
      ;;
  esac
done < <(runs)

if [ "${mode}" = verified ]; then
  echo "::error title=No verified run::No ${wf} run of ${GITHUB_SHA::12} (started by a push or a dispatch) in which ${job} succeeded." >&2
  exit 1
fi

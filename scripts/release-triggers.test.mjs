// SPDX-License-Identifier: Apache-2.0
/**
 * Two workflows publish packages, and the difference between them is the only
 * thing that keeps `npm i @nexus/cli` predictable:
 *
 *   - stable comes from a `v*` tag on master and writes the `latest` dist-tag
 *     (release.yml);
 *   - a manual run publishes a preview under `next` (npm-publish.yml) and must
 *     never touch `latest`.
 *
 * These assertions parse the workflow YAML rather than reading the text, because
 * the failure they prevent is a YAML edit: a `publish-script` put back on the
 * master-push job, or `--tag latest` copied into the manual one, would ship an
 * unreleased version to everyone who runs `npm i`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { parse } from "yaml";

const WORKFLOWS = ".github/workflows";

/** The parsed workflow document. */
function workflow(name) {
  return parse(readFileSync(`${WORKFLOWS}/${name}`, "utf8"));
}

/** Every step in the workflow that runs a publish command, with its job name. */
function publishSteps() {
  const found = [];
  for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"))) {
    const jobs = workflow(file).jobs ?? {};
    for (const [jobName, job] of Object.entries(jobs)) {
      for (const step of job?.steps ?? []) {
        const run = typeof step?.run === "string" ? step.run : "";
        if (/changeset publish|pnpm release\b/.test(run)) found.push({ file, job: jobName, run });
      }
    }
  }
  return found;
}

test("exactly one workflow writes the latest dist-tag", () => {
  const latest = publishSteps().filter((step) => /--tag latest/.test(step.run));
  assert.equal(latest.length, 1, `stable must come from one place: ${JSON.stringify(latest)}`);
  assert.equal(latest[0]?.file, "release.yml");
  assert.equal(latest[0]?.job, "publish");
});

test("the stable publish only runs from a v* tag on master", () => {
  const publish = workflow("release.yml").jobs?.publish;
  assert.ok(publish, "release.yml has no publish job");
  assert.equal(publish.if, "startsWith(github.ref, 'refs/tags/v')");
  // A tag pushed from an unmerged branch must not publish.
  const guard = (publish.steps ?? []).map((step) => String(step?.run ?? "")).join("\n");
  assert.match(guard, /git merge-base --is-ancestor HEAD FETCH_HEAD/);
});

test("pushing to master opens a version PR and publishes nothing", () => {
  const jobs = workflow("release.yml").jobs ?? {};
  const versionPr = Object.entries(jobs).find(
    ([, job]) => job?.if === "github.ref == 'refs/heads/master'",
  );
  assert.ok(versionPr, "release.yml has no master-push job");
  const [name, job] = versionPr;
  assert.equal(name, "version-pr", "the master-push job must not be the publishing one");
  const text = JSON.stringify(job);
  assert.doesNotMatch(text, /publish-script/);
  assert.doesNotMatch(text, /changeset publish/);
});

test("the manual publish is a preview on the next tag", () => {
  const publish = workflow("npm-publish.yml").jobs?.publish;
  assert.ok(publish, "npm-publish.yml has no publish job");
  const runs = (publish.steps ?? []).map((step) => String(step?.run ?? "")).join("\n");
  assert.match(runs, /changeset publish --no-git-tag --tag next/);
  assert.doesNotMatch(runs, /--tag latest/);
});

test("shipped images carry the release tag, not a floating sha", () => {
  const docker = workflow("release.yml").jobs?.["docker-release"];
  assert.ok(docker, "release.yml has no docker-release job");
  assert.equal(docker.if, "startsWith(github.ref, 'refs/tags/v')");
  const build = (docker.steps ?? []).find((step) =>
    step?.uses?.includes("docker/build-push-action"),
  );
  assert.ok(build, "docker-release does not build an image");
  assert.match(String(build.with?.tags ?? ""), /github\.ref_name/);
  assert.doesNotMatch(String(build.with?.tags ?? ""), /github\.sha/);
});

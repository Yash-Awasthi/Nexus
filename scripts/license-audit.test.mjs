// SPDX-License-Identifier: Apache-2.0
/**
 * A licence gate is only worth its green tick if it would say no. Each test below
 * takes one decision the audit makes and shows the answer it must not give.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  attribution,
  classify,
  fromLicenseFile,
  judge,
  renderNoticeBlock,
} from "./license-audit.mjs";

const MIT = `The MIT License (MIT)\n\nCopyright (c) 2019 Fabio Spampinato\n\nPermission is hereby granted, free of charge, to any person obtaining a\ncopy of this software and associated documentation files (the "Software"), to deal\nin the Software without restriction.\n`;
const MPL = `Copyright (c) 2014 HashiCorp, Inc.\n\nMozilla Public License, version 2.0\n\n1. Definitions\n\n1.1. "Contributor"\n`;
const GPL = `GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\n`;
const BSD3 = `Copyright (c) 2014\nThe BSD 3-Clause License\n\nRedistribution and use in source and binary forms, with or without\nmodification, are permitted provided that the following conditions are met:\n\n3. Neither the name of the copyright holder nor the names of its\ncontributors may be used to endorse or promote products derived from this\nsoftware without specific prior written permission.\n`;

function licenceDir(text, name = "LICENSE") {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-licence-"));
  writeFileSync(path.join(dir, name), text);
  return dir;
}

const MIT_TERM = "MIT";
const subject = (overrides) => ({
  tree: "prod",
  version: "1.0.0",
  expression: MIT_TERM,
  kind: "permissive",
  ...overrides,
});
const adr = { package: "evil", license: "GPL-3.0", adr: "docs/adr/0019-x.md", adrExists: true };

test("a licence expression is read the way its terms combine", () => {
  assert.equal(classify("MIT").kind, "permissive");
  assert.equal(classify("Apache-2.0").kind, "permissive");
  assert.equal(classify("0BSD").kind, "permissive");
  assert.equal(classify("apache-2.0").kind, "permissive", "case is not a decision");
  // Either grant is enough: dual-licensed with a copyleft alternative is still a choice.
  assert.equal(classify("MIT OR GPL-3.0-or-later").kind, "permissive");
  assert.equal(classify("(MPL-2.0 OR Apache-2.0)").kind, "permissive");
  assert.equal(classify("WTFPL OR ISC").kind, "permissive");
  // Both apply: a weak copyleft next to a permissive term stays weak.
  assert.equal(classify("Apache-2.0 AND LGPL-3.0-or-later").kind, "weak-copyleft");
  assert.equal(classify("MPL-2.0").kind, "weak-copyleft");
  assert.equal(classify("(MIT AND Zlib)").kind, "permissive");
  assert.equal(classify("GPL-3.0").kind, "strong-copyleft");
  assert.equal(classify("AGPL-3.0-only").kind, "strong-copyleft");
  assert.equal(classify("SSPL-1.0").kind, "strong-copyleft");
  assert.equal(classify("none").kind, "unclassified");
  assert.equal(classify("").kind, "unclassified");
  assert.equal(
    classify("SEE LICENCE IN readme").kind,
    "unclassified",
    "an unknown string is not a pass",
  );
});

test("a package that declares nothing is read from its own licence file", () => {
  assert.equal(fromLicenseFile(licenceDir(MIT, "license")), "MIT", "lower-case file names count");
  assert.equal(
    fromLicenseFile(licenceDir(MPL)),
    "MPL-2.0",
    'a lower-case "version 2.0" is still MPL-2.0',
  );
  assert.equal(fromLicenseFile(licenceDir(GPL)), "AGPL-3.0");
  assert.equal(fromLicenseFile(licenceDir(BSD3)), "BSD-3-Clause");
  assert.equal(fromLicenseFile(licenceDir("All rights reserved.")), "unrecognised:LICENSE");
  assert.equal(fromLicenseFile(mkdtempSync(path.join(tmpdir(), "nexus-empty-"))), null);
});

test("a strong copyleft licence needs an entry and an ADR that exists", () => {
  const gpl = subject({ name: "evil", expression: "GPL-3.0", kind: "strong-copyleft" });
  assert.match(judge([gpl], []).findings[0], /no entry in .github\/license-exceptions.json/);
  const noAdr = judge([gpl], [{ package: "evil", license: "GPL-3.0", adrExists: false }]);
  assert.match(noAdr.findings[0], /names no existing ADR/);
  const withAdr = judge([gpl], [adr]);
  assert.deepEqual(withAdr.findings, []);
  assert.ok(withAdr.used.has("evil"));
});

test("a package with no licence at all cannot pass on an entry that names none", () => {
  const none = subject({
    name: "ghost",
    expression: "none",
    kind: "unclassified",
    source: "nothing declared",
  });
  assert.match(judge([none], []).findings[0], /declares no usable licence/);
  // An entry that names the licence it found resolves it: MIT upstream is a grant.
  assert.deepEqual(
    judge([none], [{ package: "ghost", license: "MIT", adrExists: false }]).findings,
    [],
  );
  // An entry that admits there is no licence still needs the decision written down.
  assert.match(
    judge([none], [{ package: "ghost", license: "none", adrExists: false }]).findings[0],
    /names no existing ADR/,
  );
  assert.deepEqual(
    judge(
      [none],
      [{ package: "ghost", license: "none", adr: "docs/adr/0019-x.md", adrExists: true }],
    ).findings,
    [],
  );
});

test("an unmeasured module is reported, never assumed clean or failing", () => {
  const unmeasured = subject({
    name: "example.com/mod",
    kind: "unclassified",
    measured: false,
    source: "module cache empty",
  });
  const verdict = judge([unmeasured], []);
  assert.deepEqual(verdict.findings, []);
  assert.match(verdict.warnings[0], /licence unmeasured/);
});

test("a stale exception is reported, so an acceptance cannot outlive its package", () => {
  const verdict = judge([subject({ name: "present" })], [adr]);
  assert.deepEqual(verdict.stale, ["evil"]);
});

test("NOTICE lists weak copyleft once per package, whichever platform is installed", () => {
  const windows = attribution([
    subject({
      name: "lightningcss",
      version: "1.33.0",
      expression: "MPL-2.0",
      kind: "weak-copyleft",
    }),
    subject({
      name: "lightningcss-win32-x64-msvc",
      version: "1.33.0",
      expression: "MPL-2.0",
      kind: "weak-copyleft",
    }),
    subject({
      name: "@img/sharp-win32-x64",
      version: "0.35.5",
      expression: "Apache-2.0 AND LGPL-3.0-or-later",
      kind: "weak-copyleft",
    }),
    subject({ name: "isbot", version: "5.2.1", kind: "permissive" }),
  ]);
  const linux = attribution([
    subject({
      name: "lightningcss",
      version: "1.33.0",
      expression: "MPL-2.0",
      kind: "weak-copyleft",
    }),
    subject({
      name: "lightningcss-linux-x64-gnu",
      version: "1.33.0",
      expression: "MPL-2.0",
      kind: "weak-copyleft",
    }),
    subject({
      name: "@img/sharp-linux-x64",
      version: "0.35.5",
      expression: "Apache-2.0 AND LGPL-3.0-or-later",
      kind: "weak-copyleft",
    }),
  ]);
  assert.deepEqual(
    windows,
    linux,
    "the same lockfile must produce the same attribution on any host",
  );
  assert.deepEqual(
    windows.map((row) => row.name),
    ["@img/sharp-<platform>", "lightningcss", "lightningcss-<platform>"],
    "a permissive package is not attributed, and the platform tail is not part of the name",
  );
  const notice = renderNoticeBlock(windows, { prod: 4, dev: 0, go: 0 });
  assert.match(notice, /MPL-2\.0 \(prod\)/);
  assert.doesNotMatch(notice, /isbot/);
});

test("an unlicensed dependency says so in NOTICE, with the ADR that accepted it", () => {
  const rows = attribution([
    subject({
      name: "@splinetool/runtime",
      kind: "unclassified",
      expression: "none",
      source: "nothing declared",
      exception: { license: "none", adr: "docs/adr/0019-x.md" },
    }),
    subject({
      name: "@giscus/react",
      kind: "unclassified",
      expression: "none",
      source: "nothing declared",
      exception: { license: "MIT" },
    }),
  ]);
  const spline = rows.find((row) => row.name === "@splinetool/runtime");
  const giscus = rows.find((row) => row.name === "@giscus/react");
  assert.match(spline.licence, /not distributable \(docs\/adr\/0019-x\.md\)/);
  assert.match(giscus.licence, /MIT \(declared nowhere in the package/);
});

test("the committed NOTICE matches the tree, and the audit is green", () => {
  const run = spawnSync(process.execPath, ["scripts/license-audit.mjs"], { encoding: "utf8" });
  assert.equal(run.status, 0, `license-audit exited ${run.status}:\n${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /NOTICE matches the tree|no copyleft outside an ADR/);
});

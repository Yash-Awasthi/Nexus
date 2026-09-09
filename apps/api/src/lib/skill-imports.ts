// SPDX-License-Identifier: Apache-2.0
/**
 * skill-imports — single owner of the import parse/dedupe algorithm shared by
 * skill-merge (mergeSkillCodes), skill-compress (buildComposite), and
 * skill-runner (mergeSkillCodeBodies).
 *
 * All three previously carried a copy of IMPORT_RE plus the same partition
 * loop: walk a skill's code line by line; lines that look like imports are
 * collected ONCE per process of a composite (first-seen order, original line
 * text preserved — dedupe is keyed on the trimmed line), everything else
 * becomes the section body. Only this classifier/partition is shared; each
 * caller still owns its own section headers, token accounting, and assembly.
 */

/** Lines that count as "imports" for dedup purposes. */
export const IMPORT_RE =
  /^\s*(?:import\s|from\s|#include\b|using\s+\w|require\(|#\s*import\b|\b(?:const|let|var)\s+\w+\s*=\s*require\()/;

/**
 * Partition one skill's code into deduped imports + body lines.
 *
 * `imports` and `seenImports` are shared ACROSS the skills of a composite, so
 * an import that appeared in an earlier skill is skipped here. The original
 * import line (leading whitespace intact) is appended to `imports` the first
 * time its trimmed text is seen; non-import lines are returned as `body` in
 * source order.
 *
 * @param code trimmed skill code (callers trim before passing, as before)
 * @returns body lines — every line that is NOT an import, in original order
 */
export function splitSkillCodeImports(
  code: string,
  imports: string[],
  seenImports: Set<string>,
): string[] {
  const body: string[] = [];
  for (const line of code.split("\n")) {
    if (IMPORT_RE.test(line)) {
      const key = line.trim();
      if (!seenImports.has(key)) {
        seenImports.add(key);
        imports.push(line);
      }
    } else {
      body.push(line);
    }
  }
  return body;
}

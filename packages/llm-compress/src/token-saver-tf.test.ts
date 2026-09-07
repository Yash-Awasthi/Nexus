// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { compressOutputForCommand } from "./token-saver.js";

/** Build a terraform plan fixture: legend + N resource change blocks (+ noise init lines). */
function planFixture(noise: number): string {
  const lines: string[] = [
    "Terraform used the selected providers to generate the following execution plan.",
    "Resource actions are indicated with the following symbols:",
    "  + create",
    "  ~ update in-place",
    "  - destroy",
    "",
    "Terraform will perform the following actions:",
  ];
  for (let i = 0; i < noise; i++) lines.push(`Initializing provider plugins... (${i})`);
  lines.push(
    "",
    "  # aws_instance.web will be created",
    '  + resource "aws_instance" "web" {',
    '      + ami                          = "ami-0c55b159cbfafe1f0"',
    '      + instance_type                = "t2.micro"',
    '      + id                           = (known after apply)',
    "    }",
    "",
    "  # aws_security_group.sg will be updated in-place",
    '  ~ resource "aws_security_group" "sg" {',
    '        id                          = "sg-0a1b2c3d"',
    '      ~ name                        = "old-name" -> "new-name"',
    '        description                 = "unchanged description"',
    "    }",
    "",
    "  # aws_db_instance.db will be destroyed",
    '  - resource "aws_db_instance" "db" {',
    "    }",
    "",
    "Plan: 1 to add, 1 to change, 1 to destroy.",
    "",
  );
  return lines.join("\n");
}

describe("terraformOutputProcessor — plan/apply", () => {
  it("drops legend/progress noise and unchanged attrs while keeping change blocks and the summary", () => {
    const out = planFixture(5);
    const r = compressOutputForCommand("terraform plan -out=tfplan", out);
    expect(r.processor).toBe("terraform");
    expect(r.wasCompressed).toBe(true);
    // change-block headers survive
    expect(r.output).toContain("# aws_instance.web will be created");
    expect(r.output).toContain('+ resource "aws_instance" "web" {');
    // created (+) keeps all attributes
    expect(r.output).toContain("+ instance_type");
    // ~ block keeps changed lines (with the -> arrow), drops unchanged attrs
    expect(r.output).toContain('~ name                        = "old-name" -> "new-name"');
    expect(r.output).not.toContain("unchanged description");
    expect(r.output).not.toContain('id                          = "sg-0a1b2c3d"');
    // summary preserved
    expect(r.output).toContain("Plan: 1 to add, 1 to change, 1 to destroy.");
  });

  it("drops Initializing progress lines from long plans", () => {
    const r = compressOutputForCommand("tofu apply -auto-approve", planFixture(12));
    expect(r.processor).toBe("terraform");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).not.toContain("Initializing provider plugins");
  });

  it("keeps error and warning lines", () => {
    const lines = planFixture(6).split("\n");
    lines.push("", "Error: error creating Security Group: InvalidGroup.Duplicate", "");
    const r = compressOutputForCommand("terraform apply -auto-approve", lines.join("\n"));
    expect(r.processor).toBe("terraform");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("Error: error creating Security Group");
  });

  it("compresses apply progress noise down to the completion summary", () => {
    const lines = planFixture(0).split("\n");
    for (let i = 0; i < 12; i++) lines.push(`aws_instance.web: Still creating... [${i * 10}s elapsed]`);
    lines.push("aws_instance.web: Creation complete after 2m [i-0123456789abcdef0]");
    lines.push("Apply complete! Resources: 1 added, 0 changed, 0 destroyed.");
    lines.push("");
    const r = compressOutputForCommand("terraform apply -auto-approve", lines.join("\n"));
    expect(r.processor).toBe("terraform");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("Apply complete! Resources: 1 added");
    expect(r.output).not.toContain("Still creating");
    expect(r.output).not.toContain("Creation complete after 2m");
  });

  it("routes plan/apply/destroy under terraform or tofu", () => {
    const out = planFixture(8);
    for (const cmd of ["terraform plan", "tofu apply -auto-approve", "terraform destroy -auto-approve"]) {
      const r = compressOutputForCommand(cmd, out);
      expect(r.processor).toBe("terraform");
      expect(r.wasCompressed).toBe(true);
    }
  });

  it("returns short outputs unchanged (processor matched, nothing to compress)", () => {
    const short = "Plan: 0 to add, 0 to change, 0 to destroy.";
    const r = compressOutputForCommand("terraform plan", short);
    expect(r.processor).toBe("terraform");
    expect(r.wasCompressed).toBe(false);
  });
});

describe("terraformOutputProcessor — init/output/state", () => {
  it("keeps provider versions and success/error lines in init, drops noise", () => {
    const lines: string[] = ["Initializing modules...", "Initializing the backend...", "Initializing provider plugins..."];
    for (let i = 0; i < 14; i++) lines.push(`- Installing hashicorp/random v${(3 + i / 10).toFixed(2)}...`);
    lines.push("- Installed hashicorp/random v3.6.0 (signed by HashiCorp)");
    lines.push('- Finding hashicorp/aws versions matching "~> 5.0"...');
    lines.push("Terraform has been successfully initialized!");
    lines.push("");
    lines.push("Warning: Missing AWS region");
    const r = compressOutputForCommand("terraform init", lines.join("\n"));
    expect(r.processor).toBe("terraform");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("- Installed hashicorp/random v3.6.0");
    expect(r.output).toContain("Terraform has been successfully initialized!");
    expect(r.output).toContain("Warning: Missing AWS region");
    expect(r.output).not.toContain("Initializing modules");
    expect(r.output).not.toContain("Initializing provider plugins");
    expect(r.output).not.toContain("Finding hashicorp/aws");
  });

  it("truncates over-long terraform output values", () => {
    const lines: string[] = [];
    for (let i = 0; i < 35; i++) lines.push(`key_${i} = "short-${i}"`);
    lines.push(`big = "${"x".repeat(500)}"`);
    const r = compressOutputForCommand("terraform output -json", lines.join("\n"));
    expect(r.processor).toBe("terraform");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain('big = ... (');
    expect(r.output).toContain("chars)");
    expect(r.output).not.toContain("x".repeat(500));
  });

  it("groups terraform state list by resource type", () => {
    const lines: string[] = [];
    for (let i = 0; i < 15; i++) lines.push(`module.vpc.aws_subnet.private[${i}]`);
    for (let i = 0; i < 10; i++) lines.push(`aws_instance.web[${i}]`);
    for (let i = 0; i < 8; i++) lines.push(`module.db.aws_db_instance.main[${i}]`);
    const r = compressOutputForCommand("terraform state list", lines.join("\n"));
    expect(r.processor).toBe("terraform");
    expect(r.wasCompressed).toBe(true);
    expect(r.output).toContain("33 resources in state:");
    expect(r.output).toContain("  aws_subnet: 15");
    expect(r.output).toContain("  aws_instance: 10");
    expect(r.output).toContain("  aws_db_instance: 8");
  });

  it("caps long state show output", () => {
    const lines: string[] = ["# aws_instance.web:"];
    for (let i = 0; i < 100; i++) lines.push(`    attribute_${i} = "${i}"`);
    const r = compressOutputForCommand("terraform state show aws_instance.web", lines.join("\n"));
    expect(r.processor).toBe("terraform");
    expect(r.wasCompressed).toBe(true);
    const outLines = r.output.split("\n");
    expect(outLines.length).toBeLessThanOrEqual(61);
    expect(r.output).toContain("more lines)");
  });
});

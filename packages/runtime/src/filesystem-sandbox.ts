// SPDX-License-Identifier: Apache-2.0
import * as fs from "fs";
import * as path from "path";

import type { IFilesystemSandbox, ISandboxConstraint } from "./interfaces/environment.interface.js";
import { isSafeSandboxPath } from "./security-utils.js";

export class SandboxConstraint implements ISandboxConstraint {
  constructor(
    public maxWriteBytes: number,
    public allowedPathPrefix: string,
  ) {}

  validateWrite(filePath: string, contentSize: number, currentTotal: number): boolean {
    if (!isSafeSandboxPath(this.allowedPathPrefix, filePath)) {
      return false;
    }
    if (currentTotal + contentSize > this.maxWriteBytes) {
      return false;
    }
    return true;
  }
}

export class FilesystemSandbox implements IFilesystemSandbox {
  private writeLog: { timestamp: Date; file: string; bytes: number }[] = [];
  private totalBytesWritten = 0;

  constructor(
    private sandboxDir: string,
    private constraint: ISandboxConstraint,
  ) {
    if (!fs.existsSync(this.sandboxDir)) {
      fs.mkdirSync(this.sandboxDir, { recursive: true });
    }
  }

  async createDirectory(pathSegment: string): Promise<string> {
    const targetDir = path.resolve(path.join(this.sandboxDir, pathSegment));
    if (!isSafeSandboxPath(this.constraint.allowedPathPrefix, targetDir)) {
      throw new Error(
        `Sandbox Path violation: Cannot create directory outside bounds: ${targetDir}`,
      );
    }
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    return targetDir;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const targetFile = path.resolve(filePath);
    const contentSize = Buffer.byteLength(content, "utf8");

    if (!this.constraint.validateWrite(targetFile, contentSize, this.totalBytesWritten)) {
      throw new Error(
        `Sandbox Write violation: Path isolation constraint or capacity ceiling overrun: ${targetFile}`,
      );
    }

    const parentDir = path.dirname(targetFile);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(targetFile, content, "utf8");
    this.writeLog.push({
      timestamp: new Date(),
      file: targetFile,
      bytes: contentSize,
    });
    this.totalBytesWritten += contentSize;
  }

  async readFile(filePath: string): Promise<string> {
    const targetFile = path.resolve(filePath);
    if (!isSafeSandboxPath(this.constraint.allowedPathPrefix, targetFile)) {
      throw new Error(`Sandbox Read violation: Path isolation bounds breached: ${targetFile}`);
    }
    if (!fs.existsSync(targetFile)) {
      throw new Error(`File not found: ${targetFile}`);
    }
    return fs.readFileSync(targetFile, "utf8");
  }

  async deleteFile(filePath: string): Promise<void> {
    const targetFile = path.resolve(filePath);
    if (!isSafeSandboxPath(this.constraint.allowedPathPrefix, targetFile)) {
      throw new Error(`Sandbox Delete violation: Path isolation bounds breached: ${targetFile}`);
    }
    if (fs.existsSync(targetFile)) {
      fs.unlinkSync(targetFile);
    }
  }

  getWriteLog(): { timestamp: Date; file: string; bytes: number }[] {
    return this.writeLog;
  }

  async cleanup(): Promise<void> {
    if (fs.existsSync(this.sandboxDir)) {
      fs.rmSync(this.sandboxDir, { recursive: true, force: true });
    }
  }
}

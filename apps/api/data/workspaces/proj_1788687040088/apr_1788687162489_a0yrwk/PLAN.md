# Implementation Plan for `hellotool` Python Package

**Goal**: Provide a concise, reproducible plan that a coder can follow to create a minimal, self‑contained Python package named `hellotool` in the current empty workspace. The package will expose a single function `greet(name) -> str`, include a `pyproject.toml` for packaging, a `README.md` with usage examples, and a quick sanity‑check script that verifies the function works if a Python interpreter is present. The plan is deliberately tiny, dependency‑free, and fully documented.

---

## Overview
1. **Create package directory & init** – `hellotool/__init__.py` with `greet` implementation.
2. **Add packaging metadata** – `pyproject.toml` using the standard PEP 517/518 layout (set `build-system` to `setuptools` and declare minimal metadata).
3. **Write documentation** – `README.md` containing a short description, installation instructions (editable install), and a usage example.
4. **Add optional sanity‑check script** – `check.py` that imports `hellotool.greet`, runs it with a sample name, and prints the result; guarded by a `try/except` so the file can be executed even when Python is unavailable (it will simply exit with a non‑zero code, which is acceptable for the check).
5. **Validate file creation** – after each step, verify the file exists and contains the expected key strings.
6. **Final verification** – run the sanity‑check script with the system Python (if available) and confirm the output matches the expected greeting.

---

## Detailed Task List

| # | Goal | Files to Create / Modify | Acceptance Check |
|---|------|--------------------------|-------------------|
| **1** | **Create package directory and core module** | - `hellotool/__init__.py` | - File exists.<br>- Contains a function definition `def greet(name: str) -> str:`.
| **2** | **Implement `greet`** | - Same `hellotool/__init__.py` | - The function returns a formatted string `f"Hello, {name}!"`.
| **3** | **Add minimal packaging metadata** | - `pyproject.toml` | - File exists.<br>- Contains `[build-system]` with `requires = ["setuptools", "wheel"]` and `build-backend = "setuptools.build_meta"`.
| **4** | **Provide package metadata (name, version, description)** | - `pyproject.toml` (append `[project]` section) | - `[project]` section includes `name = "hellotool"`, `version = "0.1.0"`, and a short `description`.
| **5** | **Write README with usage** | - `README.md` | - File exists.
- Contains a code block showing `from hellotool import greet` and printing the result.
| **6** | **Add optional sanity‑check script** | - `check.py` | - File exists.
- Script imports `greet`, calls it with a static name (e.g., `"World"`), prints the result, and exits with code 0 on success.
| **7** | **Acceptance: Verify file contents** | - All files above | - Use `grep`/`search` to confirm each key string appears (e.g., `def greet`, `Hello, World!`).
| **8** | **Run sanity‑check** | - Execute `python check.py` via shell | - Command exits with code 0.
- Standard output equals `Hello, World!` (or similar).
| **9** | **Cleanup (optional)** | - No changes required, but note that the plan does not install the package globally. | - Workspace remains tidy; no stray temporary files.

---

## Step‑by‑Step Execution Guide

1. **Create directory** `hellotool/` and file `hellotool/__init__.py`.
2. **Write the `greet` function**:
   ```python
   def greet(name: str) -> str:
       """Return a friendly greeting for *name*.

       Example: greet("Alice") -> "Hello, Alice!"
       """
       return f"Hello, {name}!"
   ```
3. **Create `pyproject.toml`** with the following minimal content:
   ```toml
   [build-system]
   requires = ["setuptools", "wheel"]
   build-backend = "setuptools.build_meta"

   [project]
   name = "hellotool"
   version = "0.1.0"
   description = "A tiny example package that greets you."
   authors = [{name = "Your Name", email = "you@example.com"}]
   readme = "README.md"
   requires-python = ">=3.7"
   ```
4. **Write `README.md`** – include sections:
   - **Title**
   - **Brief description**
   - **Installation** (editable install: `pip install -e .`)
   - **Usage example** with a code block.
5. **Create `check.py`** – guard the import and execution:
   ```python
   try:
       from hellotool import greet
   except Exception as e:
       # Python is not available or import failed – exit non‑zero.
       import sys
       sys.exit(1)

   if __name__ == "__main__":
       print(greet("World"))
   ```
6. **Validate** each file exists and contains the expected markers using simple `grep` commands (or manual inspection).
7. **Run sanity‑check**:
   ```sh
   python check.py
   ```
   Expect output exactly `Hello, World!` and exit code `0`.
8. **Document** any deviations (e.g., Python not installed) – the plan is still considered successful if the files are correctly created.

---

### Summary
The plan walks a coder through creating a minimal `hellotool` package: set up the package directory with a single `greet` function, add a tiny `pyproject.toml` for build metadata, write a concise `README.md` with usage instructions, and provide a `check.py` script to verify the function works when Python is present. Each step includes explicit file targets and acceptance criteria, ensuring the implementation can be verified automatically without external dependencies. The entire effort stays under a few dozen lines of code and is fully self‑contained.

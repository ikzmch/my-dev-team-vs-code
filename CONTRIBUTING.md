# Contributing to My Dev Team

Thank you for your interest in contributing! This document outlines the process for contributing to this project.

## Table of Contents

- [Contributor License Agreement](#contributor-license-agreement)
- [Code of Conduct](#code-of-conduct)
- [How to Contribute](#how-to-contribute)
- [Development Setup](#development-setup)
- [Submitting Changes](#submitting-changes)
- [Coding Standards](#coding-standards)
- [Reporting Issues](#reporting-issues)

---

## Contributor License Agreement

**Before your contribution can be accepted, you must sign the Contributor License Agreement (CLA).**

By submitting a pull request, you agree to the following terms:

1. **Grant of Copyright License.** You grant Alexandr Bobrovsky and the project's recipients a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare derivative works of, publicly display, publicly perform, sublicense and distribute your contributions and such derivative works.

2. **Grant of Patent License.** You grant a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable patent license to make, have made, use, offer to sell, sell, import and otherwise transfer your contributions, where such license applies only to those patent claims licensable by you that are necessarily infringed by your contribution alone or by combination of your contribution with the project.

3. **You represent that:**
   - You are legally entitled to grant the above licenses.
   - Each of your contributions is your original creation or you have sufficient rights to submit it.
   - Your contribution does not include any third-party material unless you have permission to submit it under these terms.
   - You are not required to provide support for your contributions, except to the extent you desire to.

4. **Outbound License.** All contributions will be licensed under the same [Apache License, Version 2.0](LICENSE) that governs this project.

By opening a pull request you confirm that you have read, understood and agree to these CLA terms. If you are contributing on behalf of an employer or organization, you represent that you have the authority to bind that entity to these terms.

---

## Code of Conduct

Be respectful and constructive. Harassment, discrimination or hostile behavior will not be tolerated.

---

## How to Contribute

### Bug Reports

- Search [existing issues](../../issues) before opening a new one.
- Include a clear title and description, steps to reproduce, expected vs. actual behavior and your environment (OS, Python version).

### Feature Requests

- Open an issue describing the use case and motivation before implementing.
- Wait for feedback before investing significant effort.

### Pull Requests

- One logical change per PR.
- Reference any related issue with `Closes #123` or `Fixes #123`.
- Keep PRs focused - avoid unrelated style fixes or refactors.

---

## Development Setup

```bash
git clone https://github.com/mydevteam-ai/my-dev-team.git
cd my-dev-team

python -m venv venv
source venv/bin/activate

pip install -r requirements-dev.txt
pip install -e .
```

Run the test suite:

```bash
pytest
```

---

## Submitting Changes

1. Fork the repository and create a branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Make your changes and add tests for new behavior.
3. Ensure all tests pass: `pytest`
4. Commit with a clear message following [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add support for X
   fix: correct Y when Z
   docs: update setup instructions
   ```
5. Push your branch and open a pull request against `main`.

---

## Coding Standards

- Follow [PEP 8](https://peps.python.org/pep-0008/) style.
- Type hints are encouraged for all public functions.
- New features require accompanying tests.
- Keep functions focused and small.

---

## Reporting Issues

For security vulnerabilities, **do not** open a public issue. Contact [mydevteam.ai@gmail.com](mailto:mydevteam.ai@gmail.com) directly.

For all other issues, use the [GitHub issue tracker](../../issues).

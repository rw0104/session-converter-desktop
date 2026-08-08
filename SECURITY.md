# Security Policy

Session Converter processes authentication material, so please do not include real tokens, cookies, private keys, or exported account files in public issues.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository when available. Include a minimal reproduction with synthetic credentials and describe the affected version and platform.

## Supported versions

Security fixes are applied to the latest release and the `main` branch.

## Credential handling expectations

- Conversion runs in memory and does not persist credentials.
- Optional Codex health checks run only after an explicit user action.
- Release binaries should be built from tagged commits through the included GitHub Actions workflow.

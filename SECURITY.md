# Security Policy

Session Converter processes authentication material, so please do not include real tokens, cookies, private keys, or exported account files in public issues.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository when available. Include a minimal reproduction with synthetic credentials and describe the affected version and platform.

## Supported versions

Security fixes are applied to the latest release and the `main` branch.

## Credential handling expectations

- Conversion runs in memory and does not persist credentials.
- ChatGPT Session JSON always contains a sensitive access token and may also contain a session token; never share either value.
- Optional Codex health checks run only after an explicit user action.
- External links are opened by Rust only after HTTPS and host allowlist validation.
- Upstream update checks accept no URL input and only compare two fixed public GitHub repositories.
- Release binaries should be built from tagged commits through the included GitHub Actions workflow.

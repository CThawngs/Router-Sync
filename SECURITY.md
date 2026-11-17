# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| `0.1.0` | :white_check_mark: Read-only surface (scan, drift, inspect). Write commands require interactive confirmation. |

RouterSync is currently in pre-release (Phase 0). The read-only surface is stable in `0.1.0`.

---

## Reporting a Vulnerability

We take security and secret protection seriously. If you discover a potential vulnerability (especially regarding secret leakage, API key handling, or unintended write operations), please report it responsibly:

1. **Do not** create a public GitHub issue, pull request, or discussion.
2. Use GitHub's private vulnerability reporting: open this repository's **Security** tab and choose **Report a vulnerability**. That form is private between you and the maintainers.
3. If private reporting is not available for this repository, open a regular issue that contains only a short, non-technical description of the class of problem (no proof-of-concept, no credentials, no personal data), and ask the maintainer for a private channel.
4. Include detailed steps to reproduce the issue, environment information, and relevant sanitized logs (ensure all API keys, bearer tokens, and credentials are completely redacted).
5. You will receive an acknowledgment within 48 hours, followed by updates as the issue is investigated and resolved.

Thank you for helping keep RouterSync and its community secure!

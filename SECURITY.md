# Security Policy

## Supported Versions

We release patches for security vulnerabilities. Which versions are eligible for receiving such patches depends on the CVSS v3.0 Rating:

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of Karpenter Optimizer seriously. If you believe you have found a security vulnerability, please report it to us as described below.

### Please do NOT:

- Open a public GitHub issue
- Discuss the vulnerability in public forums
- Share the vulnerability with others until it has been resolved

### Please DO:

1. **Email us directly** at [security@kaskol10.github.io](mailto:security@kaskol10.github.io) or open a [private security advisory](https://github.com/kaskol10/karpenter-optimizer/security/advisories/new) with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if you have one)

2. **Include the following information**:
   - Affected component(s)
   - Attack vector
   - Privileges required
   - User interaction required
   - CVSS score (if you can calculate it)

3. **Allow us 90 days** to address the vulnerability before public disclosure

### What to Expect

- **Acknowledgment**: We will acknowledge receipt of your report within 48 hours
- **Initial Assessment**: We will provide an initial assessment within 7 days
- **Updates**: We will provide regular updates on the status of the vulnerability
- **Resolution**: We will work to resolve the issue as quickly as possible
- **Credit**: With your permission, we will credit you in our security advisories

### Security Best Practices

When using Karpenter Optimizer:

1. **RBAC**: Use least-privilege RBAC policies
2. **Network Policies**: Restrict network access where possible
3. **Secrets**: Never commit secrets to version control
4. **Updates**: Keep Karpenter Optimizer updated to the latest version
5. **Monitoring**: Monitor for suspicious activity
6. **Audit Logs**: Enable Kubernetes audit logging

### Known Security Considerations

- **Kubernetes API Access**: Karpenter Optimizer requires read access to nodes, pods, and NodePools
- **AWS Pricing API**: Requires internet access to fetch pricing data
- **Ollama Integration**: Optional, requires network access to Ollama instance

### Security Updates

Security updates will be:
- Released as patch versions (e.g., 1.0.1, 1.0.2)
- Documented in CHANGELOG.md
- Announced via GitHub releases
- Tagged with `security` label

### Security Audit

We recommend:
- Regular security audits of your Kubernetes clusters
- Reviewing RBAC policies periodically
- Keeping dependencies updated
- Using security scanning tools (e.g., Trivy, Snyk)

### Responsible Disclosure Timeline

- **Day 0**: Vulnerability reported
- **Day 1-2**: Acknowledgment and initial assessment
- **Day 3-7**: Detailed analysis and fix development
- **Day 8-30**: Testing and validation
- **Day 31-60**: Release preparation
- **Day 61-90**: Public disclosure (if not fixed earlier)

### Contact

For security-related issues, please contact:
- **Email**: [security@kaskol10.github.io](mailto:security@kaskol10.github.io)
- **GitHub Security Advisory**: [Create a private security advisory](https://github.com/kaskol10/karpenter-optimizer/security/advisories/new)

Thank you for helping keep Karpenter Optimizer and its users safe!


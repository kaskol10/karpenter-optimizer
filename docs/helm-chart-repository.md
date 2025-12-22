# Hosting Helm Charts on GitHub

This guide explains how to host Helm charts using GitHub Pages.

## Overview

To host Helm charts on GitHub, you need:

1. **Chart packages** (`.tgz` files) - Generated from your chart source
2. **Index file** (`index.yaml`) - Helm repository index that lists all available charts
3. **GitHub Pages** - To serve the repository files via HTTP

## Repository Structure

```
gh-pages/
├── index.yaml          # Helm repository index
└── karpenter-optimizer-0.0.10.tgz
    karpenter-optimizer-0.0.9.tgz
    ...
```

## Setup Steps

### 1. Enable GitHub Pages

1. Go to your repository Settings → Pages
2. Source: Deploy from a branch
3. Branch: `gh-pages` (create if needed)
4. Folder: `/ (root)`
5. Save

### 2. Chart Repository URL

Once set up, your Helm chart repository will be available at:
```
https://kaskol10.github.io/karpenter-optimizer
```

### 3. Using the Chart Repository

Users can add your repository and install charts:

```bash
# Add the repository
helm repo add karpenter-optimizer https://kaskol10.github.io/karpenter-optimizer

# Update repository index
helm repo update

# Install the chart
helm install karpenter-optimizer karpenter-optimizer/karpenter-optimizer
```

## Automated Publishing

The GitHub Actions workflow (`.github/workflows/helm-chart-ci.yml`) automatically:
- Packages the chart when changes are pushed
- Generates/updates the `index.yaml` file
- Publishes to the `gh-pages` branch

## Manual Publishing

If you need to publish manually:

```bash
# Package the chart
helm package charts/karpenter-optimizer --destination ./charts

# Checkout gh-pages branch
git fetch origin gh-pages:gh-pages 2>/dev/null || echo "gh-pages branch does not exist yet"
git checkout gh-pages || git checkout -b gh-pages

# Copy chart package to root (not in subdirectories)
cp charts/karpenter-optimizer-*.tgz .

# Remove any .tgz files from subdirectories to avoid incorrect URLs
rm -f charts/*.tgz || true

# Generate or update index (from root directory, not from charts/)
helm repo index . --url https://kaskol10.github.io/karpenter-optimizer

# Commit and push to gh-pages branch
git add index.yaml *.tgz
git commit -m "Add chart version X.Y.Z"
git push origin gh-pages
```

## Fixing Index Issues

If you encounter issues with duplicate entries or incorrect URLs in the index.yaml:

```bash
# Use the fix script
./scripts/fix-helm-index.sh

# Or manually regenerate the index
git checkout gh-pages
rm -f charts/*.tgz  # Remove .tgz files from subdirectories
helm repo index . --url https://kaskol10.github.io/karpenter-optimizer
git add index.yaml
git commit -m "fix: regenerate Helm chart index"
git push origin gh-pages
```

## Chart Versioning

- Update `version` in `charts/karpenter-optimizer/Chart.yaml` before publishing
- Follow [Semantic Versioning](https://semver.org/)
- Each version should be unique


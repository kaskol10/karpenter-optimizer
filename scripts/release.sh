#!/bin/bash
# Release script for Karpenter Optimizer
# Usage: ./scripts/release.sh <version> [release-notes]
# Example: ./scripts/release.sh v1.0.0 "Initial release"

set -e

VERSION=$1
RELEASE_NOTES=$2

if [ -z "$VERSION" ]; then
    echo "Error: Version is required"
    echo "Usage: $0 <version> [release-notes]"
    echo "Example: $0 v1.0.0 \"Initial release\""
    exit 1
fi

# Validate version format (should start with 'v' and be semantic version)
if [[ ! $VERSION =~ ^v[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    echo "Error: Version must be in format vX.Y.Z (e.g., v1.0.0)"
    exit 1
fi

echo "🚀 Creating release $VERSION"

# Check if we're on main branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo "⚠️  Warning: Not on main branch (current: $CURRENT_BRANCH)"
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Check if working directory is clean
if [ -n "$(git status --porcelain)" ]; then
    echo "⚠️  Warning: Working directory is not clean"
    git status --short
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Update version in Chart.yaml if it exists
if [ -f "charts/karpenter-optimizer/Chart.yaml" ]; then
    echo "📝 Updating Chart.yaml version..."
    sed -i.bak "s/^version:.*/version: ${VERSION#v}/" charts/karpenter-optimizer/Chart.yaml
    sed -i.bak "s/^appVersion:.*/appVersion: ${VERSION#v}/" charts/karpenter-optimizer/Chart.yaml
    rm -f charts/karpenter-optimizer/Chart.yaml.bak
fi

# Update version in package.json if it exists
if [ -f "frontend/package.json" ]; then
    echo "📝 Updating frontend/package.json version..."
    # Use node or sed to update version
    if command -v node &> /dev/null; then
        node -e "const fs = require('fs'); const pkg = JSON.parse(fs.readFileSync('frontend/package.json')); pkg.version = '${VERSION#v}'; fs.writeFileSync('frontend/package.json', JSON.stringify(pkg, null, 2) + '\n');"
    else
        sed -i.bak "s/\"version\":.*/\"version\": \"${VERSION#v}\",/" frontend/package.json
        rm -f frontend/package.json.bak
    fi
fi

# Commit version changes
if [ -n "$(git status --porcelain)" ]; then
    echo "📝 Committing version changes..."
    git add charts/karpenter-optimizer/Chart.yaml frontend/package.json 2>/dev/null || true
    git commit -m "chore: bump version to $VERSION" || echo "No changes to commit"
fi

# Create and push tag
echo "🏷️  Creating tag $VERSION..."
git tag -a "$VERSION" -m "$RELEASE_NOTES" || {
    echo "Error: Tag already exists or failed to create"
    exit 1
}

echo "📤 Pushing tag to remote..."
git push origin "$VERSION"

# Push commits if any
if [ -n "$(git log origin/main..HEAD)" ]; then
    echo "📤 Pushing commits to remote..."
    git push origin main
fi

echo ""
echo "✅ Release $VERSION created successfully!"
echo ""
echo "Next steps:"
echo "1. GitHub Actions will automatically:"
echo "   - Build and push Docker images"
echo "   - Create GitHub release"
echo "   - Build and publish Helm chart"
echo ""
echo "2. Verify the release:"
echo "   - Check GitHub Actions: https://github.com/kaskol10/karpenter-optimizer/actions"
echo "   - Check releases: https://github.com/kaskol10/karpenter-optimizer/releases"
echo ""
echo "3. Update CHANGELOG.md with release notes"


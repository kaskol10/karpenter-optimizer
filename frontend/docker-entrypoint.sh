#!/bin/sh
# Generate runtime config.js from environment variables
set -e

# Create config.js from environment variable
# Use single quotes in the JS to prevent issues with empty strings
API_URL="${REACT_APP_API_URL:-}"
FINAL_CONFIG="/usr/share/nginx/html/config.js"
VOLUME_CONFIG="/tmp/frontend-config/config.js"

# Generate config.js file in the volume mount (always writable)
mkdir -p /tmp/frontend-config
cat > "$VOLUME_CONFIG" <<EOF
// Runtime configuration file
// This file is generated at container startup from environment variables
window.ENV = window.ENV || {};
window.ENV.REACT_APP_API_URL = '${API_URL}';
EOF

# Copy from volume to final location
cp "$VOLUME_CONFIG" "$FINAL_CONFIG" || {
    echo "WARNING: Could not copy config.js to $FINAL_CONFIG"
    echo "File exists in volume at: $VOLUME_CONFIG"
    echo "You may need to configure nginx to serve from /tmp/frontend-config/"
}

echo "Generated config.js with REACT_APP_API_URL='${API_URL}'"
echo "Config.js location: $FINAL_CONFIG"
echo "Config.js contents:"
cat "$FINAL_CONFIG"

# Execute the main command
exec "$@"


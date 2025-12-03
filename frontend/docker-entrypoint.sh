#!/bin/sh
# Generate runtime config.js from environment variables
set -e

# Create config.js from environment variable
# Use single quotes in the JS to prevent issues with empty strings
API_URL="${REACT_APP_API_URL:-}"
cat > /usr/share/nginx/html/config.js <<EOF
// Runtime configuration file
// This file is generated at container startup from environment variables
window.ENV = window.ENV || {};
window.ENV.REACT_APP_API_URL = '${API_URL}';
EOF

echo "Generated config.js with REACT_APP_API_URL='${API_URL}'"
echo "Config.js contents:"
cat /usr/share/nginx/html/config.js

# Execute the main command
exec "$@"


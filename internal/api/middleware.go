package api

import (
	"crypto/subtle"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
)

// corsMiddleware configures CORS. The SPA is served same-origin by nginx in
// the default deployment, so no CORS headers are needed at all. When
// CORS_ALLOWED_ORIGIN is set (split deployments, local dev against a remote
// API), that single origin is echoed back. Access-Control-Allow-Credentials
// is never combined with a wildcard — the spec forbids it, and browsers
// reject the pair.
func corsMiddleware(allowedOrigin string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if allowedOrigin != "" {
			c.Writer.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
			c.Writer.Header().Set("Vary", "Origin")
			c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// corsAllowedOrigin reads CORS_ALLOWED_ORIGIN (empty = same-origin only).
func corsAllowedOrigin() string {
	return strings.TrimSpace(os.Getenv("CORS_ALLOWED_ORIGIN"))
}

// bearerAuthMiddleware requires Authorization: Bearer <token> on every route
// it is applied to. The comparison is constant-time to avoid leaking which
// prefix of the token was correct. Pass an empty token to disable (the
// middleware is simply not applied).
func bearerAuthMiddleware(token string) gin.HandlerFunc {
	expected := []byte(token)
	return func(c *gin.Context) {
		header := c.GetHeader("Authorization")
		// Accept "Bearer x" (canonical) and a bare token (clients that
		// cannot set the scheme).
		var got string
		if v, ok := strings.CutPrefix(header, "Bearer "); ok {
			got = v
		} else {
			got = header
		}
		got = strings.TrimSpace(got)
		if got != "" && subtle.ConstantTimeCompare([]byte(got), expected) == 1 {
			c.Next()
			return
		}
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
			"error":          "unauthorized",
			"hint":           "set Authorization: Bearer <token> (API_AUTH_TOKEN)",
		})
	}
}

// Package swagger provides Swagger documentation for the API.
// This file is a placeholder. Run `make swagger` to generate the actual Swagger documentation.
package swagger

// SwaggerInfo holds the generated Swagger documentation
var SwaggerInfo struct {
	ReadDoc func() string
}

func init() {
	// Default implementation that returns empty JSON
	// This will be replaced when `make swagger` is run
	SwaggerInfo.ReadDoc = func() string {
		return `{"swagger":"2.0","info":{"title":"Karpenter Optimizer API","version":"1.0"},"paths":{}}`
	}
}


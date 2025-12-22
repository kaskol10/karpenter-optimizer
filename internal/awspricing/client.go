package awspricing

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/pricing"
	"github.com/aws/aws-sdk-go-v2/service/pricing/types"
)

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// getLocationForRegion maps AWS region to Pricing API location format
func getLocationForRegion(region string) string {
	locationMap := map[string]string{
		"us-east-1":      "US East (N. Virginia)",
		"us-east-2":      "US East (Ohio)",
		"us-west-1":      "US West (N. California)",
		"us-west-2":      "US West (Oregon)",
		"eu-west-1":      "EU (Ireland)",
		"eu-west-2":      "EU (London)",
		"eu-west-3":      "EU (Paris)",
		"eu-central-1":   "EU (Frankfurt)",
		"ap-southeast-1": "Asia Pacific (Singapore)",
		"ap-southeast-2": "Asia Pacific (Sydney)",
		"ap-northeast-1": "Asia Pacific (Tokyo)",
		"ap-south-1":     "Asia Pacific (Mumbai)",
		"ca-central-1":   "Canada (Central)",
		"sa-east-1":      "South America (Sao Paulo)",
	}

	if location, ok := locationMap[region]; ok {
		return location
	}
	// Default to eu-west-1 location if region not found
	return "EU (Ireland)"
}

// Client handles AWS Pricing API requests
type Client struct {
	httpClient         *http.Client
	longHttpClient     *http.Client // Longer timeout for large downloads (instance types list)
	baseURL            string
	region             string
	cache              map[string]cachedPrice
	cacheMu            sync.RWMutex
	cacheTTL           time.Duration
	instanceTypesCache map[string]cachedInstanceTypes // Cache for instance types list
	instanceTypesMu    sync.RWMutex                   // Mutex for instance types cache
	pricingClient      *pricing.Client                // AWS SDK Pricing client (REQUIRED)
	useGetProducts     bool                           // Always true - GetProducts API is the only option
}

type pricingIndexCache struct {
	products  map[string]interface{}
	terms     map[string]interface{}
	expiresAt time.Time
}

type cachedInstanceTypes struct {
	instanceTypes []string
	expiresAt     time.Time
}

type cachedPrice struct {
	price     float64
	expiresAt time.Time
}

// NewClient creates a new AWS Pricing API client
// REQUIRES AWS credentials - uses GetProducts API to query specific instance types
// No fallback to public API (which requires downloading 400MB index)
func NewClient(region, accessKeyID, secretAccessKey, sessionToken string) (*Client, error) {
	if region == "" {
		region = "eu-west-1"
	}

	client := &Client{
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
		longHttpClient: &http.Client{
			Timeout: 60 * time.Second, // For instance types list queries (if needed)
		},
		baseURL:            "https://pricing.us-east-1.amazonaws.com",
		region:             region,
		cache:              make(map[string]cachedPrice),
		instanceTypesCache: make(map[string]cachedInstanceTypes),
		cacheTTL:           24 * time.Hour, // Cache prices for 24 hours
		useGetProducts:     true,           // Always use GetProducts API
	}

	// Initialize AWS SDK client - REQUIRED for GetProducts API
	// AWS Pricing API GetProducts is only available in us-east-1 and ap-south-1 regions
	// Even if the user specifies a different region (like eu-west-1), we need to use us-east-1 for the Pricing API endpoint
	// The location filter in the query will still use the user's specified region for pricing data
	pricingRegion := "us-east-1"
	if region == "ap-south-1" {
		pricingRegion = "ap-south-1"
	}

	// Create Pricing client with the correct region endpoint
	// Try explicit credentials first, then default credentials (IAM role, env vars, etc.)
	var pricingCfg aws.Config
	var err error

	// Only use static credentials if both are provided and non-empty
	// Otherwise, use the default credential chain which will pick up:
	// 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
	// 2. Shared credentials file (~/.aws/credentials)
	// 3. IAM role (if running on EC2/ECS/Lambda)
	if accessKeyID != "" && secretAccessKey != "" &&
		strings.TrimSpace(accessKeyID) != "" && strings.TrimSpace(secretAccessKey) != "" {
		// Use explicit static credentials with pricing region
		// Include session token if provided (for temporary credentials)
		sessionTokenValue := strings.TrimSpace(sessionToken)
		pricingCfg, err = config.LoadDefaultConfig(context.Background(),
			config.WithRegion(pricingRegion),
			config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
				strings.TrimSpace(accessKeyID),
				strings.TrimSpace(secretAccessKey),
				sessionTokenValue,
			)),
		)
	} else {
		// Use default credential chain with pricing region (will pick up env vars automatically)
		// This is the preferred method as it handles all credential sources automatically
		// The AWS SDK will automatically pick up AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_SESSION_TOKEN
		pricingCfg, err = config.LoadDefaultConfig(context.Background(),
			config.WithRegion(pricingRegion),
		)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w. AWS credentials are required for GetProducts API. "+
			"Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and optionally AWS_SESSION_TOKEN environment variables, "+
			"or configure credentials via ~/.aws/credentials, or use IAM role", err)
	}

	client.pricingClient = pricing.NewFromConfig(pricingCfg)
	client.useGetProducts = true

	return client, nil
}

// GetEC2OnDemandPrice retrieves the on-demand hourly price for an EC2 instance type
func (c *Client) GetEC2OnDemandPrice(ctx context.Context, instanceType string) (float64, error) {
	return c.GetProductPrice(ctx, instanceType, "on-demand")
}

// GetProductPrice retrieves the price for a product (on-demand or spot)
func (c *Client) GetProductPrice(ctx context.Context, instanceType, capacityType string) (float64, error) {
	// Check cache first (avoids API calls for recently queried instance types)
	c.cacheMu.RLock()
	cacheKey := fmt.Sprintf("%s-%s", instanceType, capacityType)
	if cached, ok := c.cache[cacheKey]; ok {
		if time.Now().Before(cached.expiresAt) {
			c.cacheMu.RUnlock()
			fmt.Printf("Debug: Using cached price for %s (%s): $%.4f/hr\n", instanceType, capacityType, cached.price)
			return cached.price, nil
		}
	}
	c.cacheMu.RUnlock()

	// Use GetProducts API only (requires AWS credentials)
	if !c.useGetProducts || c.pricingClient == nil {
		return 0, fmt.Errorf("AWS credentials not configured. GetProducts API requires AWS credentials (set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or use IAM role)")
	}

	// Make API call only if not in cache
	fmt.Printf("Debug: Cache miss for %s (%s), calling AWS Pricing API...\n", instanceType, capacityType)
	price, err := c.queryGetProducts(ctx, instanceType, capacityType)
	if err != nil {
		fmt.Printf("Warning: Failed to get price for %s (%s): %v\n", instanceType, capacityType, err)
		return 0, err
	}

	// Log successful price fetch
	fmt.Printf("Successfully fetched price from AWS Pricing API for %s (%s): $%.4f/hr\n", instanceType, capacityType, price)

	// Cache the result
	c.cacheMu.Lock()
	c.cache[cacheKey] = cachedPrice{
		price:     price,
		expiresAt: time.Now().Add(c.cacheTTL),
	}
	c.cacheMu.Unlock()

	return price, nil
}

// queryGetProducts uses AWS Pricing API GetProducts endpoint with filters
// This queries only the specific instance type instead of downloading the full 400MB index
func (c *Client) queryGetProducts(ctx context.Context, instanceType, capacityType string) (float64, error) {
	// Use retry logic with exponential backoff for GetProducts API
	// AWS Pricing API GetProducts can be slow and may timeout, especially for first requests
	maxRetries := 3
	backoff := 1 * time.Second // Start with 1 second
	var lastErr error

	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			// Wait before retry with exponential backoff
			select {
			case <-ctx.Done():
				return 0, ctx.Err()
			case <-time.After(backoff):
				backoff = time.Duration(float64(backoff) * 1.5) // Exponential backoff
				if backoff > 5*time.Second {
					backoff = 5 * time.Second // Cap at 5 seconds
				}
			}
		}

		// Use a longer timeout for GetProducts API (60 seconds per attempt)
		queryCtx, cancel := context.WithTimeout(ctx, 60*time.Second)

		// Map capacity type to AWS Pricing API capacity status
		// For on-demand: Use "Used" capacity status
		// For spot: We'll query on-demand price and apply discount (spot prices are dynamic)
		capacityStatus := "Used" // Used = On-Demand

		// Note: AWS Pricing API doesn't provide real-time spot prices via GetProducts
		// We'll get on-demand price and apply spot discount
		querySpot := capacityType == "spot"

		// Build filters for GetProducts API
		filters := []types.Filter{
			{
				Type:  types.FilterTypeTermMatch,
				Field: aws.String("ServiceCode"),
				Value: aws.String("AmazonEC2"),
			},
			{
				Type:  types.FilterTypeTermMatch,
				Field: aws.String("instanceType"),
				Value: aws.String(instanceType),
			},
			{
				Type:  types.FilterTypeTermMatch,
				Field: aws.String("tenancy"),
				Value: aws.String("Shared"),
			},
			{
				Type:  types.FilterTypeTermMatch,
				Field: aws.String("operatingSystem"),
				Value: aws.String("Linux"),
			},
			{
				Type:  types.FilterTypeTermMatch,
				Field: aws.String("capacitystatus"),
				Value: aws.String(capacityStatus),
			},
			{
				Type:  types.FilterTypeTermMatch,
				Field: aws.String("location"),
				Value: aws.String(getLocationForRegion(c.region)),
			},
		}

		// Query AWS Pricing API GetProducts
		input := &pricing.GetProductsInput{
			ServiceCode: aws.String("AmazonEC2"),
			Filters:     filters,
			MaxResults:  aws.Int32(1), // We only need one result
		}

		result, err := c.pricingClient.GetProducts(queryCtx, input)
		cancel()

		if err == nil {
			// Success! Parse and return the result
			if len(result.PriceList) == 0 {
				return 0, fmt.Errorf("no pricing found for instance type %s", instanceType)
			}

			// Parse the first result (should be the only one)
			var productData map[string]interface{}
			if err := json.Unmarshal([]byte(result.PriceList[0]), &productData); err != nil {
				return 0, fmt.Errorf("failed to parse product data: %w", err)
			}

			// AWS GetProducts API response structure:
			// - "product" (singular): Contains product attributes including "sku"
			// - "terms": Contains pricing information keyed by product SKU
			// The product SKU is used as the product ID to look up pricing in terms

			// Extract terms (pricing information)
			terms, ok := productData["terms"].(map[string]interface{})
			if !ok {
				var availableKeys []string
				for k := range productData {
					availableKeys = append(availableKeys, k)
				}
				return 0, fmt.Errorf("terms not found in product data (available keys: %v)", availableKeys)
			}

			// Get product SKU from product section (singular, not plural)
			var productID string
			if productRaw, exists := productData["product"]; exists {
				if productMap, ok := productRaw.(map[string]interface{}); ok {
					if sku, ok := productMap["sku"].(string); ok {
						productID = sku
					} else {
						// Try alternative: sometimes it's in attributes
						if attrs, ok := productMap["attributes"].(map[string]interface{}); ok {
							if sku, ok := attrs["sku"].(string); ok {
								productID = sku
							}
						}
					}
				}
			}

			// Fallback: Try to find product ID from terms keys if product section doesn't have SKU
			if productID == "" {
				// Look for OnDemand terms and use the first product ID found
				if onDemandTerms, ok := terms["OnDemand"].(map[string]interface{}); ok {
					for pid := range onDemandTerms {
						productID = pid
						fmt.Printf("Debug: Using product ID from terms: %s\n", productID)
						break
					}
				}
			}

			if productID == "" {
				var availableKeys []string
				for k := range productData {
					availableKeys = append(availableKeys, k)
				}
				return 0, fmt.Errorf("product ID (SKU) not found in product data (available keys: %v)", availableKeys)
			}

			// Extract price (always get on-demand price, then apply spot discount if needed)
			// Log the product ID for debugging
			fmt.Printf("Debug: Extracting price for product ID: %s (instance type: %s)\n", productID, instanceType)
			onDemandPrice, err := c.extractPriceFromTerms(terms, productID, "OnDemand")
			if err != nil {
				// Log detailed error information
				fmt.Printf("Debug: Failed to extract price for product ID %s: %v\n", productID, err)
				// Try to see what's in the terms structure
				if onDemandTerms, ok := terms["OnDemand"].(map[string]interface{}); ok {
					var termKeys []string
					for k := range onDemandTerms {
						termKeys = append(termKeys, k)
						if len(termKeys) >= 5 { // Limit to first 5 for logging
							break
						}
					}
					fmt.Printf("Debug: Available OnDemand term keys (first 5): %v\n", termKeys)
					// Try to find a matching product ID (maybe with different format)
					for termKey := range onDemandTerms {
						if strings.Contains(termKey, productID) || strings.Contains(productID, termKey) {
							fmt.Printf("Debug: Found potential match: %s (original: %s)\n", termKey, productID)
							// Try with this key
							if price, err2 := c.extractPriceFromTerms(terms, termKey, "OnDemand"); err2 == nil {
								fmt.Printf("Debug: Successfully extracted price using alternative key: %s\n", termKey)
								if querySpot {
									return price * 0.25, nil
								}
								return price, nil
							}
						}
					}
				}
				return 0, err
			}

			// Apply spot discount if querying for spot instances
			// AWS Pricing API doesn't provide real-time spot prices, so we use a conservative estimate
			if querySpot {
				return onDemandPrice * 0.25, nil // Spot is ~75% cheaper than on-demand
			}

			return onDemandPrice, nil
		}

		lastErr = err
		// Check if it's a timeout/context deadline error - retry these
		errStr := err.Error()
		if strings.Contains(errStr, "context deadline exceeded") ||
			strings.Contains(errStr, "timeout") ||
			strings.Contains(errStr, "deadline") {
			// Continue to retry
			continue
		}
		// For other errors (like invalid credentials, not found, etc.), don't retry
		return 0, fmt.Errorf("GetProducts API failed: %w", err)
	}

	return 0, fmt.Errorf("GetProducts API failed after %d retries: %w", maxRetries, lastErr)
}

// DEPRECATED: getPricingIndex is no longer used - GetProducts API is the only option
// This function is kept for reference but should never be called
//
//nolint:unused,deadcode
func (c *Client) getPricingIndex(ctx context.Context) (map[string]interface{}, map[string]interface{}, error) {
	return nil, nil, fmt.Errorf("getPricingIndex is deprecated - GetProducts API is the only option (requires AWS credentials)")
}

// productIDCache caches product IDs for instance types
type productIDCache struct {
	productIDs map[string]string // instanceType -> productID
	expiresAt  time.Time
}

var (
	productIDCacheMu  sync.RWMutex
	productIDCacheMap = make(map[string]*productIDCache) // region -> cache
)

// DEPRECATED: findProductID and queryProductFile are no longer used - GetProducts API doesn't need product IDs
// These functions are kept for reference but should never be called
//
//nolint:unused,deadcode
func (c *Client) findProductID(ctx context.Context, instanceType string) (string, error) {
	return "", fmt.Errorf("findProductID is deprecated - GetProducts API is the only option (requires AWS credentials)")
}

//nolint:unused,deadcode
func (c *Client) queryProductFile(ctx context.Context, productID, capacityType string) (float64, error) {
	return 0, fmt.Errorf("queryProductFile is deprecated - GetProducts API is the only option (requires AWS credentials)")
}

// queryPricingAPI queries the AWS Pricing API for instance pricing
// First tries to query a specific product file, falls back to full index if needed
func (c *Client) queryPricingAPI(ctx context.Context, instanceType, capacityType string) (float64, error) {
	// Try to get product ID from cache or lightweight query first
	productID, err := c.findProductID(ctx, instanceType)
	if err == nil && productID != "" {
		// Query the specific product file (much smaller than full index)
		price, err := c.queryProductFile(ctx, productID, capacityType)
		if err == nil && price > 0 {
			return price, nil
		}
		// If product file query fails, fall back to full index
	}

	// Fallback: Get the pricing index (cached or downloaded)
	products, terms, err := c.getPricingIndex(ctx)
	if err != nil {
		return 0, err
	}

	// Search for instance type and extract price
	instanceTypeLower := strings.ToLower(instanceType)
	var matchingProducts []string
	var bestProductID string
	var bestPrice float64
	var bestErr error

	// First pass: collect all matching products and prefer Linux/Shared
	for productID, productData := range products {
		productMap, ok := productData.(map[string]interface{})
		if !ok {
			continue
		}

		attributes, ok := productMap["attributes"].(map[string]interface{})
		if !ok {
			continue
		}

		if instType, ok := attributes["instanceType"].(string); ok {
			if strings.ToLower(instType) == instanceTypeLower {
				matchingProducts = append(matchingProducts, productID)

				operatingSystem, _ := attributes["operatingSystem"].(string)
				tenancy, _ := attributes["tenancy"].(string)

				// Try to extract price
				if capacityType == "spot" {
					price, err := c.extractSpotPrice(terms, productID)
					if err == nil && price > 0 {
						// Prefer Linux/Shared instances
						if operatingSystem == "Linux" && tenancy == "Shared" {
							return price, nil
						}
						// Keep track of best match
						if bestProductID == "" || (operatingSystem == "Linux" && tenancy == "Shared") {
							bestProductID = productID
							bestPrice = price
						}
					} else if bestErr == nil {
						bestErr = err
					}
				} else {
					price, err := c.extractPriceFromTerms(terms, productID, "OnDemand")
					if err == nil && price > 0 {
						// Prefer Linux/Shared instances
						if operatingSystem == "Linux" && tenancy == "Shared" {
							return price, nil
						}
						// Keep track of best match
						if bestProductID == "" || (operatingSystem == "Linux" && tenancy == "Shared") {
							bestProductID = productID
							bestPrice = price
						}
					} else if bestErr == nil {
						bestErr = err
					}
				}
			}
		}
	}

	// If we found a price, return it
	if bestPrice > 0 {
		return bestPrice, nil
	}

	// If we found matching products but couldn't extract prices, return detailed error
	if len(matchingProducts) > 0 {
		return 0, fmt.Errorf("found %d product(s) for instance type %s but could not extract price: %v (product IDs: %v)", len(matchingProducts), instanceType, bestErr, matchingProducts[:min(3, len(matchingProducts))])
	}

	return 0, fmt.Errorf("instance type %s not found in pricing index", instanceType)
}

// extractPriceFromTerms extracts the on-demand price from the terms structure
func (c *Client) extractPriceFromTerms(terms map[string]interface{}, productID, termType string) (float64, error) {
	onDemand, ok := terms["OnDemand"].(map[string]interface{})
	if !ok {
		return 0, fmt.Errorf("OnDemand terms not found in pricing index")
	}

	productTerms, ok := onDemand[productID].(map[string]interface{})
	if !ok {
		// Product ID might have a different format in terms
		// AWS Pricing API sometimes uses just the prefix before the dot, or the full ID
		// Example: product ID might be "4939GKYMFCGUTFGX.JRTCKXETXF" but terms key might be just "4939GKYMFCGUTFGX"

		// Try splitting by dot and using the first part
		if dotIdx := strings.Index(productID, "."); dotIdx > 0 {
			productIDPrefix := productID[:dotIdx]
			if pt, ok := onDemand[productIDPrefix].(map[string]interface{}); ok {
				productTerms = pt
				fmt.Printf("Debug: Found product terms using prefix %s (from %s)\n", productIDPrefix, productID)
			}
		}

		// If still not found, try to find a similar product ID
		if productTerms == nil {
			productIDPrefix := productID
			if len(productID) > 20 {
				productIDPrefix = productID[:20]
			}
			// Also try without the suffix after dot
			if dotIdx := strings.Index(productIDPrefix, "."); dotIdx > 0 {
				productIDPrefix = productIDPrefix[:dotIdx]
			}

			// Search for product IDs that start with the same prefix
			for pid := range onDemand {
				// Try exact prefix match
				if strings.HasPrefix(pid, productIDPrefix) {
					if pt, ok := onDemand[pid].(map[string]interface{}); ok {
						productTerms = pt
						fmt.Printf("Debug: Found product terms using prefix match: %s (from %s)\n", pid, productID)
						productID = pid // Use the found product ID
						break
					}
				}
				// Also try if the term key contains our product ID prefix
				if strings.Contains(pid, productIDPrefix) {
					if pt, ok := onDemand[pid].(map[string]interface{}); ok {
						productTerms = pt
						fmt.Printf("Debug: Found product terms using contains match: %s (from %s)\n", pid, productID)
						productID = pid
						break
					}
				}
			}
		}

		if productTerms == nil {
			return 0, fmt.Errorf("product terms not found for %s (searched %d OnDemand products)", productID, len(onDemand))
		}
	}

	// productTerms is a map where keys can be:
	// - Term codes (like "JRTCKXETXF") - these are nested term objects
	// - Direct keys like "sku", "effectiveDate", "offerTermCode", "termAttributes", "priceDimensions"
	// The GetProducts API response structure has priceDimensions directly in productTerms

	// First, try to get priceDimensions directly from productTerms
	if priceDimensionsRaw, ok := productTerms["priceDimensions"]; ok {
		if priceDimensions, ok := priceDimensionsRaw.(map[string]interface{}); ok {
			fmt.Printf("Debug: Found priceDimensions directly in productTerms with %d dimensions\n", len(priceDimensions))
			// Extract price from these dimensions
			for dimCode, priceData := range priceDimensions {
				if price, err := c.extractPriceFromDimension(priceData); err == nil && price > 0 {
					fmt.Printf("Debug: Successfully extracted price: $%.4f/hr from dimension %s\n", price, dimCode)
					return price, nil
				}
			}
		}
	}

	// Fallback: iterate through productTerms looking for term objects with priceDimensions
	for termCode, termData := range productTerms {
		termMap, ok := termData.(map[string]interface{})
		if !ok {
			// Skip non-map values (like "sku", "effectiveDate" which are strings)
			continue
		}

		priceDimensions, ok := termMap["priceDimensions"].(map[string]interface{})
		if !ok {
			continue
		}

		// priceDimensions is a map where keys are dimension codes
		// Each value contains the actual price information
		for dimCode, priceData := range priceDimensions {
			priceMap, ok := priceData.(map[string]interface{})
			if !ok {
				fmt.Printf("Debug: Price dimension %s is not a map, type: %T\n", dimCode, priceData)
				continue
			}

			pricePerUnit, ok := priceMap["pricePerUnit"].(map[string]interface{})
			if !ok {
				fmt.Printf("Debug: pricePerUnit not found in dimension %s, available keys: %v\n", dimCode, func() []string {
					var keys []string
					for k := range priceMap {
						keys = append(keys, k)
					}
					return keys
				}())
				continue
			}

			// Try USD first, then other currencies
			if usdPrice, ok := pricePerUnit["USD"].(string); ok {
				var price float64
				if _, err := fmt.Sscanf(usdPrice, "%f", &price); err == nil && price > 0 {
					fmt.Printf("Debug: Successfully extracted price: $%.4f/hr from term %s, dimension %s\n", price, termCode, dimCode)
					return price, nil
				} else {
					fmt.Printf("Debug: Failed to parse USD price string '%s': %v\n", usdPrice, err)
				}
			} else {
				// Log available currencies
				var currencies []string
				for k := range pricePerUnit {
					currencies = append(currencies, k)
				}
				fmt.Printf("Debug: USD not found in pricePerUnit, available currencies: %v\n", currencies)
			}
		}
	}

	return 0, fmt.Errorf("could not extract price for product %s (checked %d term codes)", productID, len(productTerms))
}

// extractPriceFromDimension extracts price from a single price dimension object
func (c *Client) extractPriceFromDimension(priceData interface{}) (float64, error) {
	priceMap, ok := priceData.(map[string]interface{})
	if !ok {
		return 0, fmt.Errorf("price dimension is not a map, type: %T", priceData)
	}

	pricePerUnit, ok := priceMap["pricePerUnit"].(map[string]interface{})
	if !ok {
		var keys []string
		for k := range priceMap {
			keys = append(keys, k)
		}
		return 0, fmt.Errorf("pricePerUnit not found in dimension, available keys: %v", keys)
	}

	// Try USD first, then other currencies
	if usdPrice, ok := pricePerUnit["USD"].(string); ok {
		var price float64
		_, err := fmt.Sscanf(usdPrice, "%f", &price)
		if err == nil && price > 0 {
			return price, nil
		}
		return 0, fmt.Errorf("failed to parse USD price string '%s': %v", usdPrice, err)
	}

	// Log available currencies for debugging
	var currencies []string
	for k := range pricePerUnit {
		currencies = append(currencies, k)
	}
	return 0, fmt.Errorf("USD not found in pricePerUnit, available currencies: %v", currencies)
}

// extractSpotPrice extracts the spot price (simplified - uses conservative estimate)
func (c *Client) extractSpotPrice(terms map[string]interface{}, productID string) (float64, error) {
	// Try to get on-demand price first
	onDemandPrice, err := c.extractPriceFromTerms(terms, productID, "OnDemand")
	if err != nil {
		return 0, err
	}

	// Conservative estimate: spot is 25% of on-demand (75% discount)
	return onDemandPrice * 0.25, nil
}

// QueryPricingAPIWithFilters queries AWS Pricing API with specific filters
// This is an alternative method that uses the GetProducts API endpoint
func (c *Client) QueryPricingAPIWithFilters(ctx context.Context, instanceType string) (float64, error) {
	// Use AWS Pricing API GetProducts endpoint
	// This requires proper AWS credentials, but provides more accurate results
	apiURL := fmt.Sprintf("%s/offers/v1.0/aws/AmazonEC2/current/%s/index.json", c.baseURL, c.region)

	// Build query parameters
	params := url.Values{}
	params.Set("FormatVersion", "aws_v1")
	params.Set("ServiceCode", "AmazonEC2")

	req, err := http.NewRequestWithContext(ctx, "GET", apiURL+"?"+params.Encode(), nil)
	if err != nil {
		return 0, fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("failed to query pricing API: %w", err)
	}
	defer func() {
		_ = resp.Body.Close() // Ignore close errors
	}()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return 0, fmt.Errorf("pricing API returned status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response (same as queryPricingAPI)
	var pricingIndex struct {
		Products map[string]interface{} `json:"products"`
		Terms    map[string]interface{} `json:"terms"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&pricingIndex); err != nil {
		return 0, fmt.Errorf("failed to decode pricing response: %w", err)
	}

	// Search for instance type and extract price
	instanceTypeLower := strings.ToLower(instanceType)
	for productID, productData := range pricingIndex.Products {
		productMap, ok := productData.(map[string]interface{})
		if !ok {
			continue
		}

		attributes, ok := productMap["attributes"].(map[string]interface{})
		if !ok {
			continue
		}

		if instType, ok := attributes["instanceType"].(string); ok {
			if strings.ToLower(instType) == instanceTypeLower {
				return c.extractPriceFromTerms(pricingIndex.Terms, productID, "OnDemand")
			}
		}
	}

	return 0, fmt.Errorf("instance type %s not found", instanceType)
}

// GetAvailableEC2InstanceTypes retrieves available EC2 instance types from AWS Pricing API
// This queries the AWS Pricing API to get a list of all available instance types for a given architecture
// The result is cached for 24 hours to avoid repeated large downloads
func (c *Client) GetAvailableEC2InstanceTypes(ctx context.Context, architecture string) ([]string, error) {
	// Check cache first
	cacheKey := architecture
	if cacheKey == "" {
		cacheKey = "all"
	}

	c.instanceTypesMu.RLock()
	if cached, ok := c.instanceTypesCache[cacheKey]; ok {
		if time.Now().Before(cached.expiresAt) {
			c.instanceTypesMu.RUnlock()
			return cached.instanceTypes, nil
		}
	}
	c.instanceTypesMu.RUnlock()

	// Query AWS Pricing API for EC2 products
	// The pricing index contains all products, we'll filter for EC2 instance types
	apiURL := fmt.Sprintf("%s/offers/v1.0/aws/AmazonEC2/current/%s/index.json", c.baseURL, c.region)

	req, err := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Use the longer timeout HTTP client for this large download
	resp, err := c.longHttpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to query pricing API: %w", err)
	}
	defer func() {
		_ = resp.Body.Close() // Ignore close errors
	}()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("pricing API returned status %d: %s", resp.StatusCode, string(body))
	}

	// Parse the pricing index JSON
	// Use a streaming decoder to handle large files more efficiently
	var pricingIndex struct {
		Products map[string]interface{} `json:"products"`
	}

	// Read body with progress tracking for large files
	decoder := json.NewDecoder(resp.Body)
	if err := decoder.Decode(&pricingIndex); err != nil {
		return nil, fmt.Errorf("failed to decode pricing index: %w", err)
	}

	// Extract instance types from products
	instanceTypeSet := make(map[string]bool)
	architectureLower := strings.ToLower(architecture)

	for _, productData := range pricingIndex.Products {
		productMap, ok := productData.(map[string]interface{})
		if !ok {
			continue
		}

		attributes, ok := productMap["attributes"].(map[string]interface{})
		if !ok {
			continue
		}

		// Check if this is an EC2 instance (not a reserved instance or other product)
		productFamily, _ := attributes["productFamily"].(string)
		if productFamily != "Compute Instance" && productFamily != "Dedicated Host" {
			continue
		}

		// Get instance type
		instanceType, ok := attributes["instanceType"].(string)
		if !ok || instanceType == "" {
			continue
		}

		// Filter by architecture if specified
		if architecture != "" {
			productArch, _ := attributes["processorArchitecture"].(string)
			if architectureLower == "arm64" {
				// ARM/Graviton instances
				if !strings.Contains(strings.ToLower(productArch), "arm") &&
					!strings.Contains(strings.ToLower(instanceType), "g") &&
					!strings.Contains(strings.ToLower(instanceType), "gd") {
					continue
				}
			} else if architectureLower == "amd64" || architectureLower == "x86_64" {
				// x86 instances (exclude ARM)
				if strings.Contains(strings.ToLower(productArch), "arm") ||
					strings.Contains(strings.ToLower(instanceType), "g") ||
					strings.Contains(strings.ToLower(instanceType), "gd") {
					continue
				}
			}
		}

		// Filter out GPU instances unless specifically requested
		if strings.HasPrefix(strings.ToLower(instanceType), "g") ||
			strings.HasPrefix(strings.ToLower(instanceType), "p") ||
			strings.HasPrefix(strings.ToLower(instanceType), "inf") {
			continue
		}

		instanceTypeSet[instanceType] = true
	}

	// Convert set to sorted slice
	instanceTypes := make([]string, 0, len(instanceTypeSet))
	for it := range instanceTypeSet {
		instanceTypes = append(instanceTypes, it)
	}

	// Sort alphabetically
	sort.Strings(instanceTypes)

	// Cache the result for 24 hours
	c.instanceTypesMu.Lock()
	c.instanceTypesCache[cacheKey] = cachedInstanceTypes{
		instanceTypes: instanceTypes,
		expiresAt:     time.Now().Add(24 * time.Hour),
	}
	c.instanceTypesMu.Unlock()

	return instanceTypes, nil
}

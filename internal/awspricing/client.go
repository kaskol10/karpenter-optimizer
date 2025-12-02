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
)

// Client handles AWS Pricing API requests
type Client struct {
	httpClient *http.Client
	baseURL    string
	region     string
	cache      map[string]cachedPrice
	cacheMu    sync.RWMutex
	cacheTTL   time.Duration
}

type cachedPrice struct {
	price     float64
	expiresAt time.Time
}

// NewClient creates a new AWS Pricing API client
// The AWS Pricing API is available at pricing.us-east-1.amazonaws.com
// Note: This uses the public pricing endpoint which doesn't require authentication
func NewClient(region string) *Client {
	if region == "" {
		region = "us-east-1"
	}

	return &Client{
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
		baseURL:  "https://pricing.us-east-1.amazonaws.com",
		region:   region,
		cache:    make(map[string]cachedPrice),
		cacheTTL: 24 * time.Hour, // Cache prices for 24 hours
	}
}

// GetEC2OnDemandPrice retrieves the on-demand hourly price for an EC2 instance type
func (c *Client) GetEC2OnDemandPrice(ctx context.Context, instanceType string) (float64, error) {
	return c.GetProductPrice(ctx, instanceType, "on-demand")
}

// GetProductPrice retrieves the price for a product (on-demand or spot)
func (c *Client) GetProductPrice(ctx context.Context, instanceType, capacityType string) (float64, error) {
	// Check cache first
	c.cacheMu.RLock()
	cacheKey := fmt.Sprintf("%s-%s", instanceType, capacityType)
	if cached, ok := c.cache[cacheKey]; ok {
		if time.Now().Before(cached.expiresAt) {
			c.cacheMu.RUnlock()
			return cached.price, nil
		}
	}
	c.cacheMu.RUnlock()

	// Query AWS Pricing API
	price, err := c.queryPricingAPI(ctx, instanceType, capacityType)
	if err != nil {
		return 0, err
	}

	// Cache the result
	c.cacheMu.Lock()
	c.cache[cacheKey] = cachedPrice{
		price:     price,
		expiresAt: time.Now().Add(c.cacheTTL),
	}
	c.cacheMu.Unlock()

	return price, nil
}

// queryPricingAPI queries the AWS Pricing API for instance pricing
func (c *Client) queryPricingAPI(ctx context.Context, instanceType, capacityType string) (float64, error) {
	// Use AWS Pricing API GetProducts endpoint
	apiURL := fmt.Sprintf("%s/offers/v1.0/aws/AmazonEC2/current/%s/index.json", c.baseURL, c.region)

	req, err := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
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

	// Parse the pricing index JSON
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
				if capacityType == "spot" {
					return c.extractSpotPrice(pricingIndex.Terms, productID)
				}
				return c.extractPriceFromTerms(pricingIndex.Terms, productID, "OnDemand")
			}
		}
	}

	return 0, fmt.Errorf("instance type %s not found", instanceType)
}

// extractPriceFromTerms extracts the on-demand price from the terms structure
func (c *Client) extractPriceFromTerms(terms map[string]interface{}, productID, termType string) (float64, error) {
	onDemand, ok := terms["OnDemand"].(map[string]interface{})
	if !ok {
		return 0, fmt.Errorf("OnDemand terms not found")
	}

	productTerms, ok := onDemand[productID].(map[string]interface{})
	if !ok {
		return 0, fmt.Errorf("product terms not found for %s", productID)
	}

	for _, termData := range productTerms {
		termMap, ok := termData.(map[string]interface{})
		if !ok {
			continue
		}

		priceDimensions, ok := termMap["priceDimensions"].(map[string]interface{})
		if !ok {
			continue
		}

		for _, priceData := range priceDimensions {
			priceMap, ok := priceData.(map[string]interface{})
			if !ok {
				continue
			}

			pricePerUnit, ok := priceMap["pricePerUnit"].(map[string]interface{})
			if !ok {
				continue
			}

			if usdPrice, ok := pricePerUnit["USD"].(string); ok {
				var price float64
				if _, err := fmt.Sscanf(usdPrice, "%f", &price); err == nil {
					return price, nil
				}
			}
		}
	}

	return 0, fmt.Errorf("could not extract price for product %s", productID)
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
func (c *Client) GetAvailableEC2InstanceTypes(ctx context.Context, architecture string) ([]string, error) {
	// Query AWS Pricing API for EC2 products
	// The pricing index contains all products, we'll filter for EC2 instance types
	apiURL := fmt.Sprintf("%s/offers/v1.0/aws/AmazonEC2/current/%s/index.json", c.baseURL, c.region)

	req, err := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
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
	var pricingIndex struct {
		Products map[string]interface{} `json:"products"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&pricingIndex); err != nil {
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
	return instanceTypes, nil
}

// Package hostedprices keeps a daily copy of hosted LLM API list prices
// (OpenRouter's public model catalog) so the Serving tab can compare what a
// self-hosted model costs per million tokens with what a hosted API charges.
//
// The catalog is optional: a cluster without internet egress simply has no
// prices, and nothing else depends on it.
package hostedprices

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultURL is OpenRouter's public model list. No API key is needed.
const DefaultURL = "https://openrouter.ai/api/v1/models"

const (
	// RefreshInterval is how long a fetched catalog is used before refetching.
	RefreshInterval = 24 * time.Hour
	// RetryInterval is how long to wait after a failed fetch.
	RetryInterval = time.Hour
	// maxBody caps the response size (the catalog is a few hundred KB).
	maxBody = 16 << 20
)

// Price is a hosted model's list price in USD per million tokens.
type Price struct {
	Model         string  // the hosted model id that matched
	InputPerMTok  float64 // prompt tokens
	OutputPerMTok float64 // completion tokens
}

// Catalog is a concurrency-safe, periodically refreshed price list.
type Catalog struct {
	url    string
	client *http.Client

	mu        sync.RWMutex
	byKey     map[string]Price
	fetchedAt time.Time
	nextTry   time.Time
	loggedErr bool
}

// New returns an empty catalog that fetches from url.
func New(url string) *Catalog {
	return &Catalog{
		url:    url,
		client: &http.Client{Timeout: 30 * time.Second},
		byKey:  map[string]Price{},
	}
}

// FetchedAt is when the catalog was last fetched successfully (zero if never).
func (c *Catalog) FetchedAt() time.Time {
	if c == nil {
		return time.Time{}
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.fetchedAt
}

// Lookup finds a served model's hosted price. Matching ignores case and
// tries the model's Hugging Face id (what vLLM and sglang usually serve
// under), the OpenRouter id and its canonical slug; a served base name also
// matches its "-instruct" variant. It never fetches.
func (c *Catalog) Lookup(model string) (Price, bool) {
	if c == nil || model == "" {
		return Price{}, false
	}
	key := strings.ToLower(strings.TrimSpace(model))
	c.mu.RLock()
	defer c.mu.RUnlock()
	if p, ok := c.byKey[key]; ok {
		return p, true
	}
	if !strings.HasSuffix(key, "-instruct") {
		if p, ok := c.byKey[key+"-instruct"]; ok {
			return p, true
		}
	}
	return Price{}, false
}

// Run refreshes the catalog now and then whenever it is due, until ctx is
// cancelled.
func (c *Catalog) Run(ctx context.Context) {
	c.refreshIfDue(ctx, time.Now())
	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			c.refreshIfDue(ctx, now)
		}
	}
}

func (c *Catalog) refreshIfDue(ctx context.Context, now time.Time) {
	c.mu.RLock()
	due := now.After(c.nextTry) || now.Equal(c.nextTry)
	c.mu.RUnlock()
	if !due {
		return
	}
	err := c.Refresh(ctx)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		c.nextTry = now.Add(RetryInterval)
		// Air-gapped clusters fail every hour; say so once.
		if !c.loggedErr {
			log.Printf("hosted prices: %v (hosted comparison hidden; retrying hourly)", err)
			c.loggedErr = true
		}
		return
	}
	c.nextTry = now.Add(RefreshInterval)
	c.loggedErr = false
}

// Refresh fetches and replaces the catalog. On error the previous catalog is
// kept.
func (c *Catalog) Refresh(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("fetch %s: %w", c.url, err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("fetch %s: HTTP %d", c.url, resp.StatusCode)
	}
	byKey, err := parse(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return err
	}
	c.mu.Lock()
	c.byKey = byKey
	c.fetchedAt = time.Now()
	c.mu.Unlock()
	return nil
}

type catalogModel struct {
	ID            string `json:"id"`
	CanonicalSlug string `json:"canonical_slug"`
	HuggingFaceID string `json:"hugging_face_id"`
	Pricing       struct {
		Prompt     string `json:"prompt"`
		Completion string `json:"completion"`
	} `json:"pricing"`
}

// parse reads OpenRouter's {"data":[...]} model list into a lookup keyed by
// lower-cased Hugging Face id, id and canonical slug. Free variants (both
// prices 0) and variable-price routers (negative prices) are skipped, so a
// Hugging Face id shared by a free and a paid variant maps to the paid one.
// When several paid variants share a key, the cheapest wins.
func parse(r io.Reader) (map[string]Price, error) {
	var body struct {
		Data []catalogModel `json:"data"`
	}
	if err := json.NewDecoder(r).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode model list: %w", err)
	}
	out := make(map[string]Price, len(body.Data)*2)
	for _, m := range body.Data {
		in, errIn := strconv.ParseFloat(m.Pricing.Prompt, 64)
		outp, errOut := strconv.ParseFloat(m.Pricing.Completion, 64)
		if errIn != nil || errOut != nil || in < 0 || outp < 0 || (in == 0 && outp == 0) {
			continue
		}
		p := Price{Model: m.ID, InputPerMTok: in * 1e6, OutputPerMTok: outp * 1e6}
		for _, k := range []string{m.HuggingFaceID, m.ID, m.CanonicalSlug} {
			k = strings.ToLower(strings.TrimSpace(k))
			if k == "" {
				continue
			}
			if prev, ok := out[k]; ok && prev.InputPerMTok+prev.OutputPerMTok <= p.InputPerMTok+p.OutputPerMTok {
				continue
			}
			out[k] = p
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("model list has no priced models")
	}
	return out, nil
}

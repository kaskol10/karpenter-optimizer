package reports

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"
)

type ReportConfig struct {
	Enabled      bool   `json:"enabled"`
	Schedule     string `json:"schedule"` // "daily", "weekly", "monthly"
	WebhookURL   string `json:"webhookUrl,omitempty"`
	EmailTo      string `json:"emailTo,omitempty"`
	SlackChannel string `json:"slackChannel,omitempty"`
}

type Report struct {
	GeneratedAt time.Time `json:"generatedAt"`
	Type        string    `json:"type"`
	Cluster     string    `json:"cluster"`
	Summary     Summary   `json:"summary"`
	Details     []Detail  `json:"details,omitempty"`
}

type Summary struct {
	TotalNodePools       int     `json:"totalNodePools"`
	TotalCurrentCost     float64 `json:"totalCurrentCost"`
	TotalRecommendedCost float64 `json:"totalRecommendedCost"`
	PotentialSavings     float64 `json:"potentialSavings"`
	SavingsPercent       float64 `json:"savingsPercent"`
}

type Detail struct {
	NodePool        string  `json:"nodePool"`
	CurrentCost     float64 `json:"currentCost"`
	RecommendedCost float64 `json:"recommendedCost"`
	Savings         float64 `json:"savings"`
}

type Reporter struct {
	config     ReportConfig
	reportFunc func() (Summary, []Detail, error)
	client     *http.Client
	mu         sync.Mutex
	stopChan   chan struct{}
}

func NewReporter(config ReportConfig, reportFunc func() (Summary, []Detail, error)) *Reporter {
	return &Reporter{
		config:     config,
		reportFunc: reportFunc,
		client: &http.Client{
			Timeout: 30 * time.Second,
		},
		stopChan: make(chan struct{}),
	}
}

func (r *Reporter) Start() error {
	if !r.config.Enabled {
		return nil
	}

	interval, err := r.getInterval()
	if err != nil {
		return err
	}

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-r.stopChan:
				return
			case <-ticker.C:
				r.sendReport()
			}
		}
	}()

	return nil
}

func (r *Reporter) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	close(r.stopChan)
}

func (r *Reporter) getInterval() (time.Duration, error) {
	switch r.config.Schedule {
	case "daily":
		return 24 * time.Hour, nil
	case "weekly":
		return 7 * 24 * time.Hour, nil
	case "monthly":
		return 30 * 24 * time.Hour, nil
	default:
		return 0, fmt.Errorf("invalid schedule: %s", r.config.Schedule)
	}
}

func (r *Reporter) sendReport() {
	summary, details, err := r.reportFunc()
	if err != nil {
		fmt.Printf("Error generating report: %v\n", err)
		return
	}

	report := Report{
		GeneratedAt: time.Now(),
		Type:        r.config.Schedule,
		Cluster:     "default",
		Summary:     summary,
		Details:     details,
	}

	if r.config.SlackChannel != "" {
		if err := r.sendSlack(report); err != nil {
			fmt.Printf("Error sending Slack report: %v\n", err)
		}
	}

	if r.config.WebhookURL != "" {
		if err := r.sendWebhook(report); err != nil {
			fmt.Printf("Error sending webhook report: %v\n", err)
		}
	}

	if r.config.EmailTo != "" {
		if err := r.sendEmail(report); err != nil {
			fmt.Printf("Error sending email report: %v\n", err)
		}
	}
}

func (r *Reporter) sendSlack(report Report) error {
	attachment := map[string]interface{}{
		"color": "#36a64f",
		"title": fmt.Sprintf("Karpenter Optimizer Report - %s", report.Type),
		"fields": []map[string]string{
			{"title": "Total NodePools", "value": fmt.Sprintf("%d", report.Summary.TotalNodePools), "short": "true"},
			{"title": "Current Cost", "value": fmt.Sprintf("$%.2f/hr", report.Summary.TotalCurrentCost), "short": "true"},
			{"title": "Recommended Cost", "value": fmt.Sprintf("$%.2f/hr", report.Summary.TotalRecommendedCost), "short": "true"},
			{"title": "Potential Savings", "value": fmt.Sprintf("$%.2f/hr (%.1f%%)", report.Summary.PotentialSavings, report.Summary.SavingsPercent), "short": "true"},
		},
	}

	payload := map[string]interface{}{
		"text":        fmt.Sprintf("Karpenter Optimizer Report - %s", report.Type),
		"attachments": []interface{}{attachment},
	}

	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", r.config.SlackChannel, bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			fmt.Printf("Warning: failed to close Slack response body: %v\n", closeErr)
		}
	}()

	if resp.StatusCode != 200 {
		return fmt.Errorf("slack webhook returned status %d", resp.StatusCode)
	}

	return nil
}

func (r *Reporter) sendWebhook(report Report) error {
	body, _ := json.Marshal(report)
	req, _ := http.NewRequest("POST", r.config.WebhookURL, bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			fmt.Printf("Warning: failed to close webhook response body: %v\n", closeErr)
		}
	}()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("webhook returned status %d", resp.StatusCode)
	}

	return nil
}

func (r *Reporter) sendEmail(report Report) error {
	fmt.Printf("Email report to %s (not implemented - use webhook for custom integrations)\n", r.config.EmailTo)
	return nil
}

func (r *Reporter) GenerateNow() (Report, error) {
	summary, details, err := r.reportFunc()
	if err != nil {
		return Report{}, err
	}

	return Report{
		GeneratedAt: time.Now(),
		Type:        "manual",
		Cluster:     "default",
		Summary:     summary,
		Details:     details,
	}, nil
}

func LoadReportConfigFromEnv() ReportConfig {
	return ReportConfig{
		Enabled:      getEnvBool("REPORT_ENABLED", false),
		Schedule:     getEnv("REPORT_SCHEDULE", "daily"),
		WebhookURL:   getEnv("REPORT_WEBHOOK_URL", ""),
		SlackChannel: getEnv("REPORT_SLACK_CHANNEL", ""),
		EmailTo:      getEnv("REPORT_EMAIL_TO", ""),
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		return value == "true" || value == "1"
	}
	return defaultValue
}

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/spf13/cobra"
)

var (
	apiURL       string
	namespace    string
	outputJSON   bool
	workloadName string
	workloadType string
)

var rootCmd = &cobra.Command{
	Use:   "karpenter-optimizer",
	Short: "Karpenter Optimizer CLI - Get nodepool recommendations",
	Long:  `A CLI tool to analyze workloads and get Karpenter nodepool recommendations.`,
}

var analyzeCmd = &cobra.Command{
	Use:   "analyze",
	Short: "Analyze workloads and get recommendations",
	Long:  `Analyze workloads from a file or stdin and get nodepool recommendations.`,
	RunE:  runAnalyze,
}

var recommendationsCmd = &cobra.Command{
	Use:   "recommendations",
	Short: "Get recommendations for a namespace",
	Long:  `Get nodepool recommendations for workloads in a namespace based on Kubernetes resource requests.`,
	RunE:  runRecommendations,
}

var metricsCmd = &cobra.Command{
	Use:   "metrics",
	Short: "Get workload metrics (deprecated)",
	Long:  `This command is deprecated. Metrics are now calculated from Kubernetes resource requests.`,
	RunE:  runMetrics,
}

func init() {
	rootCmd.PersistentFlags().StringVar(&apiURL, "api-url", "http://localhost:8080", "API server URL")
	rootCmd.PersistentFlags().BoolVar(&outputJSON, "json", false, "Output as JSON")

	analyzeCmd.Flags().StringVarP(&namespace, "namespace", "n", "", "Namespace to analyze")
	recommendationsCmd.Flags().StringVarP(&namespace, "namespace", "n", "", "Namespace to get recommendations for")
	metricsCmd.Flags().StringVarP(&namespace, "namespace", "n", "", "Namespace of the workload")
	metricsCmd.Flags().StringVar(&workloadName, "name", "", "Name of the workload")
	metricsCmd.Flags().StringVar(&workloadType, "type", "deployment", "Type of workload (deployment, statefulset, daemonset)")

	rootCmd.AddCommand(analyzeCmd)
	rootCmd.AddCommand(recommendationsCmd)
	rootCmd.AddCommand(metricsCmd)
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func runAnalyze(cmd *cobra.Command, args []string) error {
	var workloads []Workload

	// Try to read from stdin or file
	if len(args) > 0 {
		file, err := os.Open(args[0])
		if err != nil {
			return fmt.Errorf("failed to open file: %w", err)
		}
		defer func() {
			if err := file.Close(); err != nil {
				// Log error but don't fail the command
				fmt.Fprintf(os.Stderr, "Warning: failed to close file: %v\n", err)
			}
		}()

		data, err := io.ReadAll(file)
		if err != nil {
			return fmt.Errorf("failed to read file: %w", err)
		}

		if err := json.Unmarshal(data, &workloads); err != nil {
			return fmt.Errorf("failed to parse JSON: %w", err)
		}
	} else {
		// Read from stdin
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			return fmt.Errorf("failed to read stdin: %w", err)
		}

		if len(data) == 0 {
			return fmt.Errorf("no input provided")
		}

		if err := json.Unmarshal(data, &workloads); err != nil {
			return fmt.Errorf("failed to parse JSON: %w", err)
		}
	}

	reqBody := map[string]interface{}{
		"workloads": workloads,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}

	resp, err := http.Post(apiURL+"/api/v1/analyze", "application/json",
		&bytesReader{data: jsonData})
	if err != nil {
		return fmt.Errorf("failed to call API: %w", err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			// Log error but don't fail the command
			fmt.Fprintf(os.Stderr, "Warning: failed to close response body: %v\n", err)
		}
	}()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("API error: %s", string(body))
	}

	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}

	if outputJSON {
		prettyJSON, _ := json.MarshalIndent(result, "", "  ")
		fmt.Println(string(prettyJSON))
	} else {
		printRecommendations(result["recommendations"])
	}

	return nil
}

func runRecommendations(cmd *cobra.Command, args []string) error {
	url := apiURL + "/api/v1/recommendations"
	if namespace != "" {
		url += "?namespace=" + namespace
	}

	resp, err := http.Get(url)
	if err != nil {
		return fmt.Errorf("failed to call API: %w", err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			// Log error but don't fail the command
			fmt.Fprintf(os.Stderr, "Warning: failed to close response body: %v\n", err)
		}
	}()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("API error: %s", string(body))
	}

	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}

	if outputJSON {
		prettyJSON, _ := json.MarshalIndent(result, "", "  ")
		fmt.Println(string(prettyJSON))
	} else {
		printRecommendations(result["recommendations"])
	}

	return nil
}

func runMetrics(cmd *cobra.Command, args []string) error {
	if namespace == "" || workloadName == "" {
		return fmt.Errorf("namespace and name are required (use --namespace and --name flags)")
	}

	url := fmt.Sprintf("%s/api/v1/metrics/workload?namespace=%s&name=%s&type=%s",
		apiURL, namespace, workloadName, workloadType)

	resp, err := http.Get(url)
	if err != nil {
		return fmt.Errorf("failed to call API: %w", err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			// Log error but don't fail the command
			fmt.Fprintf(os.Stderr, "Warning: failed to close response body: %v\n", err)
		}
	}()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("API error: %s", string(body))
	}

	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}

	if outputJSON {
		prettyJSON, _ := json.MarshalIndent(result, "", "  ")
		fmt.Println(string(prettyJSON))
	} else {
		printMetrics(result["metrics"])
	}

	return nil
}

func printMetrics(metrics interface{}) {
	metricsMap, ok := metrics.(map[string]interface{})
	if !ok {
		fmt.Println("No metrics found")
		return
	}

	fmt.Printf("\n📈 Metrics for %s/%s:\n\n", metricsMap["namespace"], metricsMap["name"])

	if cpuUsage, ok := metricsMap["cpuUsage"].(float64); ok {
		fmt.Printf("  CPU Usage:      %.3f cores\n", cpuUsage)
	}

	if memoryUsage, ok := metricsMap["memoryUsage"].(float64); ok {
		fmt.Printf("  Memory Usage:   %.2f GiB\n", memoryUsage)
	}

	if cpuLimit, ok := metricsMap["cpuLimit"].(float64); ok && cpuLimit > 0 {
		fmt.Printf("  CPU Limit:      %.3f cores\n", cpuLimit)
	}

	if memoryLimit, ok := metricsMap["memoryLimit"].(float64); ok && memoryLimit > 0 {
		fmt.Printf("  Memory Limit:   %.2f GiB\n", memoryLimit)
	}

	if timestamp, ok := metricsMap["timestamp"].(string); ok {
		fmt.Printf("  Timestamp:      %s\n", timestamp)
	}

	fmt.Println()
}

func printRecommendations(recs interface{}) {
	recsSlice, ok := recs.([]interface{})
	if !ok {
		fmt.Println("No recommendations found")
		return
	}

	fmt.Printf("\n📊 Found %d nodepool recommendation(s):\n\n", len(recsSlice))

	for i, rec := range recsSlice {
		recMap := rec.(map[string]interface{})

		fmt.Printf("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
		fmt.Printf("Recommendation #%d: %s\n\n", i+1, recMap["name"])

		if instanceTypes, ok := recMap["instanceTypes"].([]interface{}); ok {
			fmt.Printf("  Instance Types: %v\n", instanceTypes)
		}

		if capacityType, ok := recMap["capacityType"].(string); ok {
			fmt.Printf("  Capacity Type:  %s\n", capacityType)
		}

		if arch, ok := recMap["architecture"].(string); ok {
			fmt.Printf("  Architecture:   %s\n", arch)
		}

		if minSize, ok := recMap["minSize"].(float64); ok {
			fmt.Printf("  Min Size:       %.0f\n", minSize)
		}

		if maxSize, ok := recMap["maxSize"].(float64); ok {
			fmt.Printf("  Max Size:       %.0f\n", maxSize)
		}

		if cost, ok := recMap["estimatedCost"].(float64); ok {
			fmt.Printf("  Est. Cost:      $%.2f/hour\n", cost)
		}

		if reasoning, ok := recMap["reasoning"].(string); ok {
			fmt.Printf("  Reasoning:      %s\n", reasoning)
		}

		if workloads, ok := recMap["workloadsMatched"].([]interface{}); ok && len(workloads) > 0 {
			fmt.Printf("  Workloads:      %v\n", workloads)
		}

		fmt.Println()
	}
}

type Workload struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	CPU       string            `json:"cpu"`
	Memory    string            `json:"memory"`
	GPU       int               `json:"gpu"`
	Labels    map[string]string `json:"labels"`
}

type bytesReader struct {
	data []byte
	pos  int
}

func (r *bytesReader) Read(p []byte) (n int, err error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	n = copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}

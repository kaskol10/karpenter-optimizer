# Troubleshooting Guide

## Kubernetes Connection Issues

### Problem: Cannot connect to Kubernetes cluster

**Symptoms:**
- Error messages when trying to list namespaces or workloads
- "Kubernetes client not configured" errors
- API returns 503 errors

**Solutions:**

1. **Check Kubeconfig Path**
   ```bash
   # Verify kubeconfig exists and is readable
   ls -la $KUBECONFIG
   # or
   ls -la ~/.kube/config
   ```

2. **Test Kubernetes Connection**
   ```bash
   # Test with kubectl first
   kubectl get namespaces
   
   # If kubectl works, check the context
   kubectl config current-context
   ```

3. **Set Environment Variables**
   ```bash
   # Explicitly set kubeconfig path
   export KUBECONFIG=/path/to/your/kubeconfig
   
   # Set context if needed
   export KUBE_CONTEXT=your-context-name
   
   # Start the server
   go run ./cmd/api
   ```

4. **Check Permissions**
   ```bash
   # Verify you have permissions to list namespaces
   kubectl auth can-i list namespaces
   
   # Check RBAC permissions
   kubectl get clusterrolebinding | grep your-user
   ```

5. **Verify Context Exists**
   ```bash
   # List all contexts
   kubectl config get-contexts
   
   # Verify your context is in the list
   kubectl config view
   ```

### Common Error Messages

#### "failed to build kubeconfig"
- **Cause**: Invalid kubeconfig file or path
- **Fix**: Verify kubeconfig path and file format
  ```bash
  kubectl config view --raw > /tmp/test-config.yaml
  # Check if file is valid YAML
  ```

#### "failed to set kubecontext"
- **Cause**: Context name doesn't exist in kubeconfig
- **Fix**: List contexts and use correct name
  ```bash
  kubectl config get-contexts
  # Use the exact context name from the output
  ```

#### "failed to list namespaces"
- **Cause**: Insufficient permissions or cluster connectivity issue
- **Fix**: 
  - Check network connectivity to cluster
  - Verify RBAC permissions
  - Test with kubectl: `kubectl get namespaces`

#### "Kubernetes client not configured"
- **Cause**: Client initialization failed silently
- **Fix**: Check server logs for initialization errors
  ```bash
  # Look for "Warning: Failed to initialize Kubernetes client" in logs
  ```

### Debug Steps

1. **Enable Verbose Logging**
   ```bash
   # Check server startup logs
   go run ./cmd/api 2>&1 | tee server.log
   ```

2. **Test API Health Endpoint**
   ```bash
   curl http://localhost:8080/api/v1/health
   # Should show kubernetes status
   ```

3. **Test Namespace Endpoint**
   ```bash
   curl http://localhost:8080/api/v1/namespaces
   # Check error message for details
   ```

4. **Verify Kubeconfig Format**
   ```bash
   # Check if kubeconfig is valid
   kubectl --kubeconfig=$KUBECONFIG config view
   ```

### Environment Variables

Make sure these are set correctly:

```bash
# Required for Kubernetes access
export KUBECONFIG=/path/to/kubeconfig

# Optional: specify context
export KUBE_CONTEXT=my-context

# Optional: Ollama for AI-powered explanations
export OLLAMA_URL=http://localhost:11434
export OLLAMA_MODEL=granite4:latest

# Optional: API server port
export PORT=8080
```

### In-Cluster Configuration

If running inside Kubernetes (as a pod):

- Don't set `KUBECONFIG` - it will use in-cluster config automatically
- Don't set `KUBE_CONTEXT` - contexts don't apply in-cluster
- Ensure ServiceAccount has proper RBAC permissions

### Testing Connection

```bash
# Test the Kubernetes client directly
go run -tags debug ./cmd/api

# Or test via API
curl http://localhost:8080/api/v1/health
# Check the "kubernetes" field in response
```

## AWS Pricing API Issues

### Problem: Cannot fetch instance pricing

**Symptoms:**
- Recommendations show estimated costs instead of actual AWS pricing
- Cost calculations may be less accurate

**Solutions:**

1. **Verify AWS Credentials**
   ```bash
   # Check if AWS credentials are configured
   aws sts get-caller-identity
   ```

2. **Check AWS Permissions**
   - Ensure credentials have `pricing:GetProducts` permission
   - Or use IAM role with appropriate permissions if running in AWS

3. **Fallback Behavior**
   - The system will automatically fall back to hardcoded pricing if AWS API is unavailable
   - Recommendations will still work, but costs may be estimates

## Ollama Integration Issues

### Problem: AI explanations not working

**Symptoms:**
- Recommendations don't include reasoning explanations
- API returns recommendations without AI-generated text

**Solutions:**

1. **Verify Ollama is Running**
   ```bash
   curl http://localhost:11434/api/tags
   # Should return list of available models
   ```

2. **Check Ollama URL**
   ```bash
   # Set correct Ollama URL
   export OLLAMA_URL=http://localhost:11434
   # Or if running in cluster
   export OLLAMA_URL=http://ollama-service:11434
   ```

3. **Verify Model is Available**
   ```bash
   # List available models
   curl http://localhost:11434/api/tags
   
   # Pull model if needed
   curl http://localhost:11434/api/pull -d '{"name": "gemma2:2b"}'
   ```

4. **Ollama is Optional**
   - Recommendations work without Ollama
   - AI explanations are optional enhancements
   - System gracefully handles Ollama unavailability

## General Debugging

### Check Server Logs

The server logs initialization status:
```
Starting Karpenter Optimizer API
  Port: 8080
  Kubeconfig: /path/to/kubeconfig
  Kube Context: my-context
Successfully connected to Kubernetes cluster
```

Or if there's an error:
```
Warning: Failed to initialize Kubernetes client: <error details>
Kubernetes features will be disabled.
```

### Health Check Endpoint

```bash
curl http://localhost:8080/api/v1/health
```

Response shows connection status:
```json
{
  "status": "healthy",
  "service": "karpenter-optimizer",
  "kubernetes": "connected",  // or "not configured"
  "prometheus": "not supported"  // Prometheus support removed - uses Kubernetes API directly
}
```

**Note:** Prometheus is no longer used. The tool analyzes Kubernetes resource requests and node usage data directly from the Kubernetes API. This provides more accurate recommendations based on actual pod resource allocations.

## How Data Collection Works

The tool uses a **Kubernetes-native approach** that doesn't require Prometheus:

1. **Resource Requests Analysis**: Reads pod resource requests directly from the Kubernetes API
2. **Node Usage Calculation**: Calculates CPU and memory usage by summing pod requests on each node
3. **NodePool Analysis**: Fetches existing Karpenter NodePool configurations and actual node instances
4. **Real-time Data**: Uses current cluster state - no external metrics required

### Troubleshooting Resource Data Issues

#### Problem: Recommendations show zero or incorrect resource usage

**Symptoms:**
- Recommendations don't match actual cluster usage
- CPU/Memory usage appears as zero
- Node counts seem incorrect

**Solutions:**

1. **Verify Pods Have Resource Requests**
   ```bash
   # Check if pods have resource requests set
   kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].resources.requests}{"\n"}{end}'
   ```

2. **Check Node Allocatable Resources**
   ```bash
   # Verify nodes have allocatable resources
   kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.allocatable.cpu}{"\t"}{.status.allocatable.memory}{"\n"}{end}'
   ```

3. **Verify Pods Are Scheduled**
   ```bash
   # Only scheduled pods (with nodeName) are counted
   kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.nodeName}{"\n"}{end}' | grep -v "^$"
   ```

4. **Check NodePool Resources**
   ```bash
   # Verify NodePools exist and have nodes
   kubectl get nodepools
   kubectl get nodes -l karpenter.sh/nodepool
   ```

#### Problem: NodePool recommendations not appearing

**Symptoms:**
- No recommendations returned for NodePools
- Empty recommendations array

**Solutions:**

1. **Verify NodePools Exist**
   ```bash
   # Check if NodePools are configured
   kubectl get nodepools
   ```

2. **Check Nodes Are Associated with NodePools**
   ```bash
   # Verify nodes have NodePool labels
   kubectl get nodes --show-labels | grep karpenter.sh/nodepool
   ```

3. **Verify NodePools Have Nodes**
   - Recommendations only appear for NodePools with actual nodes
   - Empty NodePools are skipped

4. **Check API Endpoint**
   ```bash
   # Test NodePool endpoint directly
   curl http://localhost:8080/api/v1/nodepools
   ```

#### Problem: Cost calculations seem incorrect

**Symptoms:**
- Estimated costs don't match AWS pricing
- Cost savings calculations seem off

**Solutions:**

1. **Check AWS Pricing API Access**
   - See "AWS Pricing API Issues" section above
   - Verify credentials have pricing API permissions

2. **Verify Instance Types**
   ```bash
   # Check actual instance types in cluster
   kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.labels.node\.kubernetes\.io/instance-type}{"\n"}{end}' | sort -u
   ```

3. **Check Capacity Types**
   ```bash
   # Verify spot vs on-demand nodes
   kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.karpenter\.sh/capacity-type}{"\n"}{end}'
   ```

4. **Review Cost Calculation Logic**
   - Spot instances: 25% of on-demand price (75% discount)
   - On-demand instances: Full AWS Pricing API price
   - Unknown capacity type: Defaults to on-demand


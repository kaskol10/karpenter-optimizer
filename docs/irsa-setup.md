# IRSA (IAM Roles for Service Accounts) Setup

IRSA (IAM Roles for Service Accounts) is the recommended way to provide AWS credentials to Karpenter Optimizer when running on Amazon EKS. This eliminates the need to manage AWS access keys and follows AWS security best practices.

## Overview

While the AWS Pricing API uses a public endpoint that doesn't require authentication, using IRSA provides:
- **Security**: No need to store AWS credentials as secrets
- **Best Practices**: Follows AWS recommended patterns for EKS workloads
- **Future-Proof**: Enables future enhancements that may require authenticated AWS API calls
- **Auditability**: IAM roles provide better audit trails

## Prerequisites

- EKS cluster with OIDC provider configured
- `eksctl` or `aws` CLI installed
- Appropriate IAM permissions to create roles and policies

## Step 1: Create IAM Policy

Create an IAM policy that grants access to the AWS Pricing API:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "pricing:GetProducts",
        "pricing:DescribeServices"
      ],
      "Resource": "*"
    }
  ]
}
```

Save this as `karpenter-optimizer-policy.json` and create the policy:

```bash
aws iam create-policy \
  --policy-name KarpenterOptimizerPolicy \
  --policy-document file://karpenter-optimizer-policy.json
```

Note the policy ARN (e.g., `arn:aws:iam::ACCOUNT_ID:policy/KarpenterOptimizerPolicy`).

## Step 2: Create IAM Role

Create an IAM role with a trust policy that allows your EKS service account to assume it.

### Get Your EKS Cluster OIDC Issuer URL

```bash
aws eks describe-cluster --name YOUR_CLUSTER_NAME --query "cluster.identity.oidc.issuer" --output text
```

### Create Trust Policy

Create `trust-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/OIDC_PROVIDER_ID"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "OIDC_PROVIDER_ID:sub": "system:serviceaccount:NAMESPACE:SERVICE_ACCOUNT_NAME",
          "OIDC_PROVIDER_ID:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

Replace:
- `ACCOUNT_ID`: Your AWS account ID
- `OIDC_PROVIDER_ID`: Your OIDC provider ID (from step above, e.g., `oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B716D3041E`)
- `NAMESPACE`: Kubernetes namespace (e.g., `karpenter-optimizer`)
- `SERVICE_ACCOUNT_NAME`: Service account name (e.g., `karpenter-optimizer`)

### Create IAM Role

```bash
aws iam create-role \
  --role-name karpenter-optimizer-role \
  --assume-role-policy-document file://trust-policy.json
```

### Attach Policy to Role

```bash
aws iam attach-role-policy \
  --role-name karpenter-optimizer-role \
  --policy-arn arn:aws:iam::ACCOUNT_ID:policy/KarpenterOptimizerPolicy
```

Note the role ARN (e.g., `arn:aws:iam::ACCOUNT_ID:role/karpenter-optimizer-role`).

## Step 3: Configure Helm Chart

Update your `values.yaml` to use IRSA:

```yaml
serviceAccount:
  create: true
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT_ID:role/karpenter-optimizer-role

config:
  aws:
    region: "us-east-1"
```

Or install with `--set`:

```bash
helm install karpenter-optimizer ./charts/karpenter-optimizer \
  --namespace karpenter-optimizer \
  --create-namespace \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::ACCOUNT_ID:role/karpenter-optimizer-role \
  --set config.aws.region=us-east-1
```

## Step 4: Verify IRSA Setup

After deploying, verify the pod has the AWS credentials:

```bash
# Check the pod is running
kubectl get pods -n karpenter-optimizer

# Check environment variables (should include AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE)
kubectl exec -n karpenter-optimizer deployment/karpenter-optimizer -- env | grep AWS

# Test AWS API access
kubectl exec -n karpenter-optimizer deployment/karpenter-optimizer -- \
  aws pricing get-products --service-code AmazonEC2 --region us-east-1
```

## Using eksctl (Alternative Method)

If you're using `eksctl`, you can create the IAM role and service account in one command:

```bash
eksctl create iamserviceaccount \
  --name karpenter-optimizer \
  --namespace karpenter-optimizer \
  --cluster YOUR_CLUSTER_NAME \
  --attach-policy-arn arn:aws:iam::ACCOUNT_ID:policy/KarpenterOptimizerPolicy \
  --approve \
  --override-existing-serviceaccounts
```

Then update your Helm values:

```yaml
serviceAccount:
  create: false  # eksctl already created it
  name: karpenter-optimizer
```

## Troubleshooting

### Pod fails to start with IRSA

1. **Check OIDC provider**: Ensure your EKS cluster has an OIDC provider:
   ```bash
   aws eks describe-cluster --name YOUR_CLUSTER_NAME --query "cluster.identity.oidc.issuer"
   ```

2. **Verify trust policy**: Ensure the trust policy matches your service account:
   ```bash
   aws iam get-role --role-name karpenter-optimizer-role --query "Role.AssumeRolePolicyDocument"
   ```

3. **Check service account**: Verify the service account has the annotation:
   ```bash
   kubectl get serviceaccount -n karpenter-optimizer karpenter-optimizer -o yaml
   ```

4. **Check pod logs**: Look for AWS credential errors:
   ```bash
   kubectl logs -n karpenter-optimizer deployment/karpenter-optimizer
   ```

### AWS API calls fail

1. **Verify IAM permissions**: Ensure the IAM policy is attached:
   ```bash
   aws iam list-attached-role-policies --role-name karpenter-optimizer-role
   ```

2. **Test from pod**: Try making an AWS API call from the pod:
   ```bash
   kubectl exec -n karpenter-optimizer deployment/karpenter-optimizer -- \
     aws sts get-caller-identity
   ```

## Additional Resources

- [AWS EKS IRSA Documentation](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html)
- [eksctl IRSA Guide](https://eksctl.io/usage/iamserviceaccounts/)
- [AWS Pricing API Documentation](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html)


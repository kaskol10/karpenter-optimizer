# Acknowledgments

## eks-node-viewer

Karpenter Optimizer is heavily influenced by [eks-node-viewer](https://github.com/awslabs/eks-node-viewer), a fantastic tool by AWS Labs that I've been using for the last couple of years.

**What eks-node-viewer provides:**
- Excellent node visualization
- Real-time cluster state monitoring
- Great foundation for understanding cluster topology

**What Karpenter Optimizer adds:**
1. **Easy visualization** - Modern React web UI vs CLI-only
2. **Track pods in nodes** - Detailed pod-to-node mapping with resource usage visualization
3. **Clarify node disruptions** - Shows why nodes are blocked (PDBs, pod constraints, etc.)
4. **Focus on Karpenter** - Built specifically for Karpenter NodePools with NodePool-level analysis
5. **Current cost opportunities** - AI-powered cost recommendations with actual savings calculations

We're grateful to the eks-node-viewer team for creating such a valuable tool that inspired this project!

## Other Acknowledgments

- **Karpenter** - The amazing Kubernetes node autoscaler that makes this tool possible
- **Kubernetes Community** - For the excellent APIs and ecosystem
- **AWS** - For Karpenter, EKS, and the Pricing API
- **Open Source Contributors** - All the amazing libraries and tools we use


# Lumora Pool battlecard (fictional sample for testing)

**Main alternatives**
- **Buy more GPUs (H200 or B200) for their HBM.** Strong performance but expensive; you pay for compute you don't need just to get memory.
- **Vantage Fabric (fictional competitor).** Software-only memory tiering over RDMA. Cheaper to start, but higher latency and no CXL hardware path.
- **Do nothing / software paging (vLLM PagedAttention).** Free and already in use, but hits a ceiling on very long contexts.

**Common objections and responses**
- *"CXL adds latency."* About 200 to 300 ns per access; for KV-cache offload the throughput gain usually outweighs it. Offer the pilot to measure p95 latency.
- *"Security review takes months."* Appliance runs inside their rack; no data leaves the premises. Share the security pack early.
- *"We have no budget this year."* Pilot is free; tie the business case to GPUs not purchased.

**Discovery questions to ask**
- How long are the longest contexts you serve today, and where do you run out of memory?
- How do you measure inference cost today?
- Who approves new infrastructure vendors, and what does that process look like?
- What would a successful pilot need to show?
- What alternatives are you considering, including buying more GPUs?

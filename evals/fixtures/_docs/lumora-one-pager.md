# Lumora Pool: product one-pager (fictional sample for testing)

Lumora Systems is a fictional company used only to test Signal.

**What it is:** Lumora Pool is a rack-level CXL memory pooling appliance. It lets GPU and CPU servers in a rack share a large pool of memory over CXL (Compute Express Link) instead of each server being limited to its own DRAM.

**Who it's for:** teams running large-model inference with long context windows, where the KV cache (the model's working memory for a conversation) outgrows GPU HBM and server DRAM.

**Key specs**
- Up to 24 TB of pooled DDR5 per rack, CXL 2.0 today, CXL 3.0 upgrade path
- Adds roughly 200 to 300 nanoseconds of latency versus local DRAM
- Works with vLLM and TensorRT-LLM KV-cache offload through the Lumora plugin

**Value**
- Serve longer contexts and more concurrent users per GPU
- Fewer GPUs bought only for their memory
- Pilot: 30 days, one rack, success measured on tokens per second per dollar and p95 latency

**Pricing:** annual subscription per rack; pilot is free with a signed evaluation agreement.

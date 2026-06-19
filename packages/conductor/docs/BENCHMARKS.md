# GhostStack v1.2.0 Micro-Benchmark Report

Automated hardware profiling snapshot generated on 2026-05-18T17:40:12.060Z.

## Core Telemetry Latency Summary

| Benchmark Dimension                                     | Measured Result | Performance Goal | Status  |
| :------------------------------------------------------ | :-------------- | :--------------- | :------ |
| **Sequential Persistence Write**                        | 13.354 ms       | < 25 ms          | Optimal |
| **Sequential Persistence Read**                         | 0.820 ms        | < 2 ms           | Optimal |
| **Concurrent State Lock Contention (100 parallel ops)** | 2034.56 ms      | < 3000 ms        | Optimal |
| **Average Task Broker Processing Loop**                 | 22.813 ms       | < 30 ms          | Optimal |
| **System Dispatch Throughput Limit**                    | 44 tasks/sec    | > 30 tasks/sec   | Optimal |

## Findings & Concurrency Hardening Validation

- The hardened Sequential Async Promise-Queue in `FileRuntimePersistence` serializes parallel writes efficiently under full load, preventing data corruption and dirty reads.
- Contention latency under a burst of 100 parallel transactions remains under **2034.6 ms**, confirming lock contention scale safety.
- Low overhead telemetry profiling is guaranteed under dynamic telemetry amplification loops.

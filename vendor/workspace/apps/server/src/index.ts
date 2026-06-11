/**
 * Workspace — Server Entry Point
 * ─────────────────────────
 * Boots the Orchestrator, registers all 18 agents, then exposes
 * a minimal HTTP API for task submission and health queries.
 */
import http from 'node:http';
import { Orchestrator } from '@workspace/orchestrator';
import { StateStore }   from '@workspace/core';

// ── Agent imports ──────────────────────────────────────────────────
import { createAgent as createResearcher }   from '@workspace/agent-researcher';
import { createAgent as createCoder }        from '@workspace/agent-coder';
import { createAgent as createGithub }       from '@workspace/agent-github';
import { createAgent as createSlack }        from '@workspace/agent-slack';
import { createAgent as createLinear }       from '@workspace/agent-linear';
import { createAgent as createDeploy }       from '@workspace/agent-deploy';
import { createAgent as createDatabase }     from '@workspace/agent-database';
import { createAgent as createSecrets }      from '@workspace/agent-secrets';
import { createAgent as createEmail }        from '@workspace/agent-email';
import { createAgent as createCalendar }     from '@workspace/agent-calendar';
import { createAgent as createDrive }        from '@workspace/agent-drive';
import { createAgent as createContent }      from '@workspace/agent-content';
import { createAgent as createAnalyst }      from '@workspace/agent-analyst';
import { createAgent as createMonitor }      from '@workspace/agent-monitor';
import { createAgent as createScheduler }    from '@workspace/agent-scheduler';
import { createAgent as createMemory }       from '@workspace/agent-memory';
import { createAgent as createOrchestrator } from '@workspace/agent-orchestrator';
import { createAgent as createYash }         from '@workspace/agent-yash';

const PORT = Number(process.env['PORT'] ?? 3000);

async function main() {
  const orchestrator = new Orchestrator();
  const { bus, registry } = orchestrator;
  const state = new StateStore();

  // Register all 18 agents
  const agents = [
    createResearcher(bus, state),
    createCoder(bus, state),
    createGithub(bus, state),
    createSlack(bus, state),
    createLinear(bus, state),
    createDeploy(bus, state),
    createDatabase(bus, state),
    createSecrets(bus, state),
    createEmail(bus, state),
    createCalendar(bus, state),
    createDrive(bus, state),
    createContent(bus, state),
    createAnalyst(bus, state),
    createMonitor(bus, state),
    createScheduler(bus, state),
    createMemory(bus, state),
    createOrchestrator(bus, state),
    createYash(bus, state),
  ];

  for (const agent of agents) registry.register(agent);
  await orchestrator.start();

  // ── HTTP API ────────────────────────────────────────────────────
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

    // GET /health — system health
    if (req.method === 'GET' && url.pathname === '/health') {
      const healths = registry.allHealths();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', agents: healths }));
      return;
    }

    // POST /task — submit a task to an agent
    if (req.method === 'POST' && url.pathname === '/task') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const { agentId, input } = JSON.parse(body) as { agentId: string; input: string };
          const agent = registry.get(agentId as never);
          if (!agent) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Agent '${agentId}' not found` }));
            return;
          }
          const result = await agent.execute({
            id:        `req-${Date.now()}`,
            agentId:   agentId as never,
            input,
            priority:  'normal',
            createdAt: new Date(),
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(PORT, () => {
    console.log(`Workspace server running on http://localhost:${PORT}`);
    console.log(`${registry.size()} agents ready`);
  });

  // Graceful shutdown
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      console.log(`\nReceived ${signal} — shutting down...`);
      server.close();
      await orchestrator.shutdown();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

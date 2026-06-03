/**
 * Arc Agent Retainer MCP Server
 *
 * Layer 5: Recurring USDC subscription payment tools.
 * Create plans, subscribe, charge cycles, cancel subscriptions.
 *
 * Add to Claude Desktop:
 * {
 *   "mcpServers": {
 *     "arc-retainer": {
 *       "command": "npx",
 *       "args": ["tsx", "/path/to/arc-agent-retainer/src/mcp/server.ts"],
 *       "env": { "AGENT_PRIVATE_KEY": "0x...", "AGENT_RETAINER_ADDRESS": "0x..." }
 *     }
 *   }
 * }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { AgentRetainerClient, PLAN_STATUS, SUBSCRIPTION_STATUS } from "../retainer/retainer.js";
import "dotenv/config";

const client = new AgentRetainerClient();
const server = new Server({ name: "arc-agent-retainer", version: "0.1.0" }, { capabilities: { tools: {} } });

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format a raw USDC amount (6 decimals) as a human-readable string, e.g. 10000000 -> "10.00 USDC" */
function formatUsdc(raw: bigint): string {
  return (Number(raw) / 1_000_000).toFixed(2) + " USDC";
}

/** Format seconds into a human-readable interval string. */
function formatInterval(seconds: bigint): string {
  const s = Number(seconds);
  if (s >= 86400) return `${(s / 86400).toFixed(1)} days`;
  if (s >= 3600)  return `${(s / 3600).toFixed(1)} hours`;
  return `${s} seconds`;
}

/** ArcScan transaction URL */
function txUrl(hash: string): string {
  return `https://testnet.arcscan.app/tx/${hash}`;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "arc_create_plan",
      description:
        "Create a recurring USDC subscription plan for an agent. Define the price per cycle and billing interval.",
      inputSchema: {
        type: "object",
        properties: {
          agentTokenId: {
            type: "number",
            description: "Token ID of the agent offering this plan.",
          },
          priceUsdc: {
            type: "number",
            description: "USDC price per billing cycle (e.g. 5.0 for 5 USDC).",
          },
          intervalSeconds: {
            type: "number",
            description: "Billing interval in seconds (minimum 3600 = 1 hour). Common: 2592000 = 30 days.",
          },
          description: {
            type: "string",
            description: "Human-readable description of what the plan offers.",
          },
        },
        required: ["agentTokenId", "priceUsdc", "intervalSeconds", "description"],
      },
    },
    {
      name: "arc_get_plan",
      description:
        "Get full details of a subscription plan including price, interval, status, and subscriber count.",
      inputSchema: {
        type: "object",
        properties: {
          planId: {
            type: "number",
            description: "ID of the plan to look up.",
          },
        },
        required: ["planId"],
      },
    },
    {
      name: "arc_deactivate_plan",
      description:
        "Deactivate a plan so no new subscriptions can be created. Existing subscriptions remain active.",
      inputSchema: {
        type: "object",
        properties: {
          planId: {
            type: "number",
            description: "ID of the plan to deactivate.",
          },
        },
        required: ["planId"],
      },
    },
    {
      name: "arc_subscribe",
      description:
        "Subscribe to a plan. Auto-approves USDC allowance for 12 billing cycles. First charge happens after one interval.",
      inputSchema: {
        type: "object",
        properties: {
          planId: {
            type: "number",
            description: "ID of the plan to subscribe to.",
          },
        },
        required: ["planId"],
      },
    },
    {
      name: "arc_cancel_subscription",
      description:
        "Cancel an active subscription. Only the subscriber can cancel. No refunds for past charges.",
      inputSchema: {
        type: "object",
        properties: {
          subscriptionId: {
            type: "number",
            description: "ID of the subscription to cancel.",
          },
        },
        required: ["subscriptionId"],
      },
    },
    {
      name: "arc_charge_subscription",
      description:
        "Execute a charge on a subscription. Permissionless — anyone can call once the billing interval has elapsed.",
      inputSchema: {
        type: "object",
        properties: {
          subscriptionId: {
            type: "number",
            description: "ID of the subscription to charge.",
          },
        },
        required: ["subscriptionId"],
      },
    },
    {
      name: "arc_get_subscription",
      description:
        "Get full details of a subscription including status, cycle count, total charged, and next charge time.",
      inputSchema: {
        type: "object",
        properties: {
          subscriptionId: {
            type: "number",
            description: "ID of the subscription to look up.",
          },
        },
        required: ["subscriptionId"],
      },
    },
    {
      name: "arc_list_plans_by_agent",
      description: "List all subscription plans offered by an agent.",
      inputSchema: {
        type: "object",
        properties: {
          agentTokenId: {
            type: "number",
            description: "Token ID of the agent.",
          },
        },
        required: ["agentTokenId"],
      },
    },
    {
      name: "arc_list_subscriptions_by_client",
      description: "List all subscriptions held by a client address.",
      inputSchema: {
        type: "object",
        properties: {
          clientAddress: {
            type: "string",
            description: "Client wallet address (0x-prefixed). Defaults to the configured wallet if omitted.",
          },
        },
        required: [],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool call handler
// ---------------------------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // -----------------------------------------------------------------------
      case "arc_create_plan": {
        const { agentTokenId, priceUsdc, intervalSeconds, description } = args as {
          agentTokenId: number;
          priceUsdc: number;
          intervalSeconds: number;
          description: string;
        };

        const { planId, hash } = await client.createPlan(
          BigInt(agentTokenId),
          priceUsdc,
          intervalSeconds,
          description,
        );

        return {
          content: [
            {
              type: "text",
              text: [
                `Subscription plan created successfully.`,
                ``,
                `Plan ID      : ${planId}`,
                `Agent        : #${agentTokenId}`,
                `Price        : ${priceUsdc.toFixed(2)} USDC per cycle`,
                `Interval     : ${formatInterval(BigInt(intervalSeconds))}`,
                `Description  : "${description}"`,
                ``,
                `Transaction  : ${txUrl(hash)}`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_get_plan": {
        const { planId } = args as { planId: number };

        const plan = await client.getPlan(BigInt(planId));

        const statusLabel = PLAN_STATUS[plan.status as keyof typeof PLAN_STATUS] ?? "Unknown";

        return {
          content: [
            {
              type: "text",
              text: [
                `Plan #${planId} -- "${plan.description}"`,
                ``,
                `Agent        : #${plan.agentTokenId}`,
                `Price        : ${formatUsdc(plan.priceUsdc)}`,
                `Interval     : ${formatInterval(plan.intervalSeconds)}`,
                `Status       : ${statusLabel}`,
                `Subscribers  : ${plan.subscriberCount}`,
                `Created      : ${new Date(Number(plan.createdAt) * 1000).toISOString()}`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_deactivate_plan": {
        const { planId } = args as { planId: number };

        const hash = await client.deactivatePlan(BigInt(planId));

        return {
          content: [
            {
              type: "text",
              text: [
                `Plan deactivated. No new subscriptions will be accepted.`,
                ``,
                `Plan ID      : ${planId}`,
                ``,
                `Transaction  : ${txUrl(hash)}`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_subscribe": {
        const { planId } = args as { planId: number };

        const { subscriptionId, hash } = await client.subscribe(BigInt(planId));

        // Fetch plan to show price info
        const plan = await client.getPlan(BigInt(planId));

        return {
          content: [
            {
              type: "text",
              text: [
                `Subscribed successfully.`,
                ``,
                `Subscription : #${subscriptionId}`,
                `Plan         : #${planId} -- "${plan.description}"`,
                `Price        : ${formatUsdc(plan.priceUsdc)} per ${formatInterval(plan.intervalSeconds)}`,
                `First charge : after ${formatInterval(plan.intervalSeconds)}`,
                ``,
                `Transaction  : ${txUrl(hash)}`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_cancel_subscription": {
        const { subscriptionId } = args as { subscriptionId: number };

        const hash = await client.cancelSubscription(BigInt(subscriptionId));

        return {
          content: [
            {
              type: "text",
              text: [
                `Subscription cancelled.`,
                ``,
                `Subscription : #${subscriptionId}`,
                ``,
                `Transaction  : ${txUrl(hash)}`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_charge_subscription": {
        const { subscriptionId } = args as { subscriptionId: number };

        const hash = await client.charge(BigInt(subscriptionId));

        // Fetch updated subscription to show cycle info
        const sub = await client.getSubscription(BigInt(subscriptionId));
        const plan = await client.getPlan(sub.planId);

        const statusLabel = SUBSCRIPTION_STATUS[sub.status as keyof typeof SUBSCRIPTION_STATUS] ?? "Unknown";

        return {
          content: [
            {
              type: "text",
              text: [
                `Subscription charged.`,
                ``,
                `Subscription : #${subscriptionId}`,
                `Status       : ${statusLabel}`,
                `Amount       : ${formatUsdc(plan.priceUsdc)}`,
                `Cycle        : ${sub.cycleCount}`,
                `Total Paid   : ${formatUsdc(sub.totalCharged)}`,
                ``,
                `Transaction  : ${txUrl(hash)}`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_get_subscription": {
        const { subscriptionId } = args as { subscriptionId: number };

        const sub = await client.getSubscription(BigInt(subscriptionId));
        const plan = await client.getPlan(sub.planId);

        const statusLabel = SUBSCRIPTION_STATUS[sub.status as keyof typeof SUBSCRIPTION_STATUS] ?? "Unknown";
        const nextChargeTs = Number(sub.lastChargedAt) + Number(plan.intervalSeconds);
        const nextChargeDate = new Date(nextChargeTs * 1000).toISOString();

        return {
          content: [
            {
              type: "text",
              text: [
                `Subscription #${subscriptionId}`,
                ``,
                `Plan         : #${sub.planId} -- "${plan.description}"`,
                `Client       : ${sub.client}`,
                `Status       : ${statusLabel}`,
                `Price        : ${formatUsdc(plan.priceUsdc)} per ${formatInterval(plan.intervalSeconds)}`,
                `Cycles       : ${sub.cycleCount}`,
                `Total Paid   : ${formatUsdc(sub.totalCharged)}`,
                `Started      : ${new Date(Number(sub.startedAt) * 1000).toISOString()}`,
                `Last Charged : ${new Date(Number(sub.lastChargedAt) * 1000).toISOString()}`,
                `Next Charge  : ${nextChargeDate}`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_list_plans_by_agent": {
        const { agentTokenId } = args as { agentTokenId: number };

        const planIds = await client.getPlansByAgent(BigInt(agentTokenId));

        if (planIds.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Agent #${agentTokenId} has no subscription plans.`,
              },
            ],
          };
        }

        const plans = await Promise.all(
          planIds.map((id) => client.getPlan(id)),
        );

        const lines: string[] = [
          `Plans for Agent #${agentTokenId} (${planIds.length} total):`,
          ``,
        ];

        plans.forEach((p, i) => {
          const id = planIds[i];
          const statusLabel = PLAN_STATUS[p.status as keyof typeof PLAN_STATUS] ?? "Unknown";
          lines.push(
            `  Plan #${id} -- "${p.description}"`,
            `    Price: ${formatUsdc(p.priceUsdc)} | Interval: ${formatInterval(p.intervalSeconds)} | Status: ${statusLabel} | Subscribers: ${p.subscriberCount}`,
            ``,
          );
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      // -----------------------------------------------------------------------
      case "arc_list_subscriptions_by_client": {
        const { clientAddress } = (args ?? {}) as { clientAddress?: string };

        const subIds = await client.getSubscriptionsByClient(
          clientAddress ? (clientAddress as `0x${string}`) : undefined,
        );

        if (subIds.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No subscriptions found for ${clientAddress ?? "configured wallet"}.`,
              },
            ],
          };
        }

        const subs = await Promise.all(
          subIds.map((id) => client.getSubscription(id)),
        );

        const lines: string[] = [
          `Subscriptions for ${clientAddress ?? "configured wallet"} (${subIds.length} total):`,
          ``,
        ];

        for (let i = 0; i < subs.length; i++) {
          const s = subs[i];
          const id = subIds[i];
          const statusLabel = SUBSCRIPTION_STATUS[s.status as keyof typeof SUBSCRIPTION_STATUS] ?? "Unknown";
          lines.push(
            `  Subscription #${id} -- Plan #${s.planId}`,
            `    Status: ${statusLabel} | Cycles: ${s.cycleCount} | Total Paid: ${formatUsdc(s.totalCharged)}`,
            ``,
          );
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      }

      // -----------------------------------------------------------------------
      default:
        return {
          content: [{ type: "text", text: `Error: Unknown tool "${name}"` }],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

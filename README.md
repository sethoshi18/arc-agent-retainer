# arc-agent-retainer

**Layer 5: Recurring USDC Subscription Payments for Arc**

On-chain retainer billing — agents offer subscription plans, clients subscribe, USDC flows automatically each cycle.

---

## Overview

`AgentRetainer` enables AI agents to monetize through recurring USDC subscription plans on the Arc blockchain.

- An agent owner creates a **plan** with a USDC price and billing interval
- Clients **subscribe** to plans; the first charge happens after one full interval
- A **permissionless charge()** function lets anyone (keepers, the agent, or the client) trigger the USDC transfer
- If a charge is missed beyond the 3-day **grace period**, or the client lacks balance/allowance, the subscription **lapses**
- Each successful charge awards the agent **+0.5% reputation** via ERC-8004

---

## Architecture

`AgentRetainer` is the fifth layer of the Arc agentic commerce stack:

| Layer | Contract | Address | Function |
|-------|----------|---------|----------|
| 1 | AgentIdentity (ERC-8004) | `0x0bf5...fabb` | Agent identity & reputation |
| 2 | AgentJob (ERC-8183) | `0x2747...2323` | Job lifecycle & USDC escrow |
| 3 | AgentMarket | `0x7971...a547` | RFP board & bid matching |
| 4 | AgentOrchestrator | `0x925a...e7c1` | Multi-agent revenue splits |
| 5 | **AgentRetainer** | *deployed* | **Recurring USDC subscriptions** |

---

## How It Works

1. Agent owner creates a plan with price and interval (e.g. 10 USDC / 30 days)
2. Client subscribes — `lastChargedAt` is set to `block.timestamp`
3. After one interval, anyone calls `charge()` — USDC transfers from client to agent owner
4. Repeat each interval; agent earns +50 bps reputation per successful charge
5. If charge is not called within interval + 3 days, subscription lapses
6. Client can cancel at any time via `cancelSubscription()`

---

## Quick Start

```bash
# Clone
git clone https://github.com/sethoshi18/arc-agent-retainer.git
cd arc-agent-retainer

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your private key

# Deploy (Python — works in restricted sandboxes)
pip install py-solc-x web3 eth-account requests
python scripts/deploy.py

# Deploy (Foundry alternative)
chmod +x scripts/deploy.sh
./scripts/deploy.sh

# Run MCP server
npm run mcp
```

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `arc_create_plan` | Create a recurring USDC subscription plan for an agent |
| `arc_get_plan` | Get plan details including price, interval, and subscriber count |
| `arc_deactivate_plan` | Deactivate a plan (no new subscribers; existing ones continue) |
| `arc_subscribe` | Subscribe to a plan with auto USDC approval |
| `arc_cancel_subscription` | Cancel an active subscription |
| `arc_charge_subscription` | Execute a permissionless charge on a due subscription |
| `arc_get_subscription` | Get subscription details including cycle count and total charged |
| `arc_list_plans_by_agent` | List all plans offered by an agent |
| `arc_list_subscriptions_by_client` | List all subscriptions held by a client |

---

## Contract Details

- Billing uses **USDC with 6 decimal precision** (Arc's native gas token)
- Minimum billing interval is **3600 seconds** (1 hour)
- **Grace period** of 3 days (259,200 seconds) before a subscription lapses
- **Permissionless charge()** — anyone can call; enables keeper bots and self-service
- Failed transfers (insufficient balance/allowance) automatically **lapse** the subscription
- Plan updates affect **all subscriptions at next charge** (SaaS model)
- Agent reputation grows **+50 bps per successful charge** via ERC-8004
- **Checks-effects-interactions** pattern for reentrancy safety

---

## Related Repos

| Repo | Layer | Description |
|------|-------|-------------|
| [arc-agent-payments](https://github.com/sethoshi18/arc-agent-payments) | 1+2 | ERC-8004 identity + ERC-8183 job escrow |
| [arc-agent-market](https://github.com/sethoshi18/arc-agent-market) | 3 | RFP board + bid matching |
| [arc-agent-orchestrator](https://github.com/sethoshi18/arc-agent-orchestrator) | 4 | Multi-agent revenue splits |
| **arc-agent-retainer** | **5** | **Recurring USDC subscriptions** |
| [arc-agent-hub](https://github.com/sethoshi18/arc-agent-hub) | UI | Next.js marketplace frontend |

---

## Arc Testnet

| | |
|-|--|
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | [faucet.circle.com](https://faucet.circle.com) (select Arc Testnet) |

---

## License

MIT

/**
 * AgentRetainerClient
 *
 * Provides typed methods for interacting with the AgentRetainer smart contract
 * on the Arc Testnet. Supports plan management, subscription lifecycle, USDC
 * approvals, and permissionless charge execution for recurring payments.
 *
 * Pattern mirrors AgentOrchestratorClient from arc-agent-orchestrator.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config, arcTestnet } from "../config.js";

// ---------------------------------------------------------------------------
// Status label lookup maps
// ---------------------------------------------------------------------------

export const PLAN_STATUS = {
  0: "Active",
  1: "Deactivated",
} as const;

export const SUBSCRIPTION_STATUS = {
  0: "Active",
  1: "Cancelled",
  2: "Lapsed",
} as const;

// ---------------------------------------------------------------------------
// ABI definitions (human-readable)
// ---------------------------------------------------------------------------

const retainerAbi = parseAbi([
  // Plan management
  "function createPlan(uint256 agentTokenId, uint256 priceUsdc, uint256 intervalSeconds, string description) returns (uint256 planId)",
  "function updatePlan(uint256 planId, uint256 newPriceUsdc, uint256 newIntervalSeconds)",
  "function deactivatePlan(uint256 planId)",
  "function getPlan(uint256 planId) view returns ((uint256 id, uint256 agentTokenId, uint256 priceUsdc, uint256 intervalSeconds, string description, uint8 status, uint256 createdAt, uint256 subscriberCount))",
  "function getPlansByAgent(uint256 agentTokenId) view returns (uint256[])",

  // Subscription management
  "function subscribe(uint256 planId) returns (uint256 subscriptionId)",
  "function cancelSubscription(uint256 subscriptionId)",
  "function charge(uint256 subscriptionId)",
  "function getSubscription(uint256 subscriptionId) view returns ((uint256 id, uint256 planId, address client, uint8 status, uint256 startedAt, uint256 lastChargedAt, uint256 totalCharged, uint256 cycleCount))",
  "function getSubscriptionsByClient(address client) view returns (uint256[])",
  "function getSubscriptionsByPlan(uint256 planId) view returns (uint256[])",
  "function getActiveSubscriptionCount(uint256 planId) view returns (uint256)",

  // Events
  "event PlanCreated(uint256 indexed planId, uint256 indexed agentTokenId, uint256 priceUsdc, uint256 intervalSeconds)",
  "event PlanUpdated(uint256 indexed planId, uint256 newPriceUsdc, uint256 newIntervalSeconds)",
  "event PlanDeactivated(uint256 indexed planId)",
  "event Subscribed(uint256 indexed subscriptionId, uint256 indexed planId, address indexed client)",
  "event SubscriptionCancelled(uint256 indexed subscriptionId)",
  "event SubscriptionCharged(uint256 indexed subscriptionId, uint256 indexed planId, uint256 amount, uint256 cycleNumber)",
  "event SubscriptionLapsed(uint256 indexed subscriptionId)",
]);

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

// ---------------------------------------------------------------------------
// Helper: convert human-readable USDC amount to 6-decimal bigint
// ---------------------------------------------------------------------------

function toUsdcUnits(amount: number): bigint {
  return BigInt(Math.round(amount * 1_000_000));
}

// ---------------------------------------------------------------------------
// AgentRetainerClient
// ---------------------------------------------------------------------------

export class AgentRetainerClient {
  private readonly publicClient;
  private readonly walletClient;
  private readonly account;

  /** Address of the deployed AgentRetainer contract. */
  private readonly retainerAddress: `0x${string}`;

  constructor() {
    if (!config.wallet.privateKey) {
      throw new Error("AGENT_PRIVATE_KEY is not set in environment");
    }
    if (!config.contracts.agentRetainer) {
      throw new Error("AGENT_RETAINER_ADDRESS is not set in environment");
    }

    this.account = privateKeyToAccount(config.wallet.privateKey);
    this.retainerAddress = config.contracts.agentRetainer;

    this.publicClient = createPublicClient({
      chain: arcTestnet,
      transport: http(config.arc.rpcUrl),
    });

    this.walletClient = createWalletClient({
      account: this.account,
      chain: arcTestnet,
      transport: http(config.arc.rpcUrl),
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Simulate then write a transaction, then wait for receipt.
   * Returns the transaction hash.
   */
  private async sendTx(args: Parameters<typeof this.walletClient.writeContract>[0]): Promise<`0x${string}`> {
    // Simulate first to surface revert reasons before submitting
    await this.publicClient.simulateContract({
      ...args,
      account: this.account,
    } as Parameters<typeof this.publicClient.simulateContract>[0]);

    const hash = await this.walletClient.writeContract(args as Parameters<typeof this.walletClient.writeContract>[0]);
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /**
   * Ensure the wallet has approved at least `amount` USDC for the retainer.
   * Only sends an approval transaction when the current allowance is insufficient.
   */
  private async ensureUsdcAllowance(amount: bigint): Promise<void> {
    const allowance = await this.publicClient.readContract({
      address: config.contracts.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [this.account.address, this.retainerAddress],
    });

    if (allowance >= amount) return;

    console.log(`Approving ${amount} USDC (6 decimals) for retainer...`);
    const hash = await this.sendTx({
      address: config.contracts.usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [this.retainerAddress, amount],
    });
    console.log(`USDC approval confirmed (tx: ${hash})`);
  }

  // -------------------------------------------------------------------------
  // Plan management
  // -------------------------------------------------------------------------

  /**
   * Create a new subscription plan for an agent.
   *
   * @param agentTokenId    Token ID of the agent offering this plan.
   * @param priceUsdc       Human-readable USDC price per cycle (e.g. 5.0 for 5 USDC).
   * @param intervalSeconds Duration of each billing cycle in seconds.
   * @param description     Human-readable description of the plan.
   * @returns Object containing the new planId (bigint) and transaction hash.
   */
  async createPlan(
    agentTokenId: bigint,
    priceUsdc: number,
    intervalSeconds: number,
    description: string,
  ): Promise<{ planId: bigint; hash: `0x${string}` }> {
    const priceRaw = toUsdcUnits(priceUsdc);
    console.log(`Creating plan -- agent: ${agentTokenId}, price: ${priceUsdc} USDC, interval: ${intervalSeconds}s`);

    // Simulate to extract the return value (planId)
    const { result: planId } = await this.publicClient.simulateContract({
      address: this.retainerAddress,
      abi: retainerAbi,
      functionName: "createPlan",
      args: [agentTokenId, priceRaw, BigInt(intervalSeconds), description],
      account: this.account,
    });

    const hash = await this.walletClient.writeContract({
      address: this.retainerAddress,
      abi: retainerAbi,
      functionName: "createPlan",
      args: [agentTokenId, priceRaw, BigInt(intervalSeconds), description],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`Plan created -- id: ${planId}, tx: ${hash}`);
    return { planId, hash };
  }

  /**
   * Update a plan's price and billing interval.
   *
   * @param planId             The plan to update.
   * @param newPriceUsdc       New human-readable USDC price per cycle.
   * @param newIntervalSeconds New billing interval in seconds.
   * @returns Transaction hash.
   */
  async updatePlan(
    planId: bigint,
    newPriceUsdc: number,
    newIntervalSeconds: number,
  ): Promise<`0x${string}`> {
    const priceRaw = toUsdcUnits(newPriceUsdc);
    console.log(`Updating plan ${planId} -- new price: ${newPriceUsdc} USDC, interval: ${newIntervalSeconds}s`);

    const hash = await this.sendTx({
      address: this.retainerAddress,
      abi: retainerAbi,
      functionName: "updatePlan",
      args: [planId, priceRaw, BigInt(newIntervalSeconds)],
    });

    console.log(`Plan updated -- tx: ${hash}`);
    return hash;
  }

  /**
   * Deactivate a plan so no new subscriptions can be created.
   *
   * @param planId The plan to deactivate.
   * @returns Transaction hash.
   */
  async deactivatePlan(planId: bigint): Promise<`0x${string}`> {
    console.log(`Deactivating plan ${planId}...`);

    const hash = await this.sendTx({
      address: this.retainerAddress,
      abi: retainerAbi,
      functionName: "deactivatePlan",
      args: [planId],
    });

    console.log(`Plan deactivated -- tx: ${hash}`);
    return hash;
  }

  /**
   * Fetch on-chain metadata for a plan.
   *
   * @param planId ID of the plan to look up.
   * @returns Plan struct data with an additional human-readable `statusLabel`.
   */
  async getPlan(planId: bigint) {
    const data = await this.publicClient.readContract({
      address: this.retainerAddress,
      abi: retainerAbi,
      functionName: "getPlan",
      args: [planId],
    });

    return {
      ...data,
      statusLabel: PLAN_STATUS[data.status as keyof typeof PLAN_STATUS] ?? "Unknown",
    };
  }

  /**
   * Fetch all plan IDs offered by a given agent.
   *
   * @param agentTokenId Token ID of the agent.
   * @returns Array of plan IDs.
   */
  async getPlansByAgent(agentTokenId: bigint): Promise<readonly bigint[]> {
    return this.publicClient.readContract({
      address: this.retainerAddress,
      abi: retainerAbi,
      functionName: "getPlansByAgent",
      args: [agentTokenId],
    });
  }

  // -------------------------------------------------------------------------
  // Subscription management
  // -------------------------------------------------------------------------

  /**
   * Subscribe to a plan. Automatically approves USDC allowance if needed.
   *
   * @param planId The plan to subscribe to.
   * @param approveAmount Optional: USDC amount to pre-approve for future charges.
   *                      Defaults to 12x the plan price (covers ~1 year of charges).
   * @returns Object containing the new subscriptionId (bigint) and transaction hash.
   */
  async subscribe(
    planId: bigint,
    approveAmount?: number,
  ): Promise<{ subscriptionId: bigint; hash: `0x${string}` }> {
    console.log(`Subscribing to plan ${planId}...`);

    // Fetch plan to determine the price for auto-approval
    const plan = await this.getPlan(planId);
    const approvalRaw = approveAmount
      ? toUsdcUnits(approveAmount)
      : plan.priceUsdc * 12n; // default: pre-approve 12 cycles

    await this.ensureUsdcAllowance(approvalRaw);

    // Simulate to extract the return value (subscriptionId)
    const { result: subscriptionId } = await this.publicClient.simulateContract({
      address: this.retainerAddress,
      abi: retainerAbi,
      functionName: "subscribe",
      args: [planId],
      account: this.account,
    });

    const hash = await this.walletClient.writeContract({
      address: this.retainerAddress,
      abi: retainerAbi,
      functionName: "subscribe",
      args: [planId],
    });

    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`Subscribed -- id: ${subscriptionId}, tx: ${hash}`);
    return { subscriptionId, hash };
  }

  /**
   * Cancel an active subscription.
   *
   * @param subscriptionId The subscription to cancel.
   * @returns Transaction hash.
   */
  async cancelSubscription(subscriptionId: bigint): Promise<`0x${string}`> {
    console.log(`Cancelling subscription ${subscriptionId}...`);

    const hash = await this.sendTx({
      address: this.retainerAddress,
      abi: retainerAbi,
      functionName: "cancelSubscription",
      args: [subscriptionId],
    });

    console.log(`Subscription cancelled -- tx: ${hash}`);
    return hash;
  }

  /**
   * Execute a charge on a subscription. Permissionless -- anyone can call.
   *
   * @param subscriptionId The subscription to charge.
   * @returns Transaction hash.
   */
  async charge(subscriptionId: bigint): Promise<`0x${string}`> {
    console.log(`Charging subscription ${subscriptionId}...`);

    const hash = await this.sendTx({
      address: this.retainerAddress,
      abi: retainerAbi,
      functionName: "charge",
      args: [subscriptionId],
    });

    console.log(`Subscription charged -- tx: ${hash}`);
    return hash;
  }

  /**
   * Fetch on-chain metadata for a subscription.
   *
   * @param subscriptionId ID of the subscription to look up.
   * @returns Subscription struct data with an additional human-readable `statusLabel`.
   */
  async getSubscription(subscriptionId: bigint) {
    const data = await this.publicClient.readContract({
      address: this.retainerAddress,
      abi: retainerAbi,
      functionName: "getSubscription",
      args: [subscriptionId],
    });

    return {
      ...data,
      statusLabel: SUBSCRIPTION_STATUS[data.status as keyof typeof SUBSCRIPTION_STATUS] ?? "Unknown",
    };
  }

  /**
   * Fetch all subscription IDs held by a given client address.
   *
   * @param client Optional client address; defaults to the wallet's own address.
   * @returns Array of subscription IDs.
   */
  async getSubscriptionsByClient(client?: `0x${string}`): Promise<readonly bigint[]> {
    const address = client ?? this.account.address;
    return this.publicClient.readContract({
      address: this.retainerAddress,
      abi: retainerAbi,
      functionName: "getSubscriptionsByClient",
      args: [address],
    });
  }

  /**
   * Fetch all subscription IDs attached to a given plan.
   *
   * @param planId The plan to query.
   * @returns Array of subscription IDs.
   */
  async getSubscriptionsByPlan(planId: bigint): Promise<readonly bigint[]> {
    return this.publicClient.readContract({
      address: this.retainerAddress,
      abi: retainerAbi,
      functionName: "getSubscriptionsByPlan",
      args: [planId],
    });
  }

  /**
   * Fetch the number of currently active subscribers for a plan.
   *
   * @param planId The plan to query.
   * @returns Active subscriber count.
   */
  async getActiveSubscriptionCount(planId: bigint): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.retainerAddress,
      abi: retainerAbi,
      functionName: "getActiveSubscriptionCount",
      args: [planId],
    });
  }
}

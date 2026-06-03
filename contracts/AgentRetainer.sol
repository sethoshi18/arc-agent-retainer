// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// =============================================================================
// Inline Interfaces
// =============================================================================

/**
 * @title IAgentIdentity
 * @notice Interface for the Arc Agent Identity Registry (Layer 1).
 *         Agents are ERC-721 tokens with on-chain reputation.
 */
interface IAgentIdentity {
    struct AgentIdentity {
        address owner;
        string name;
        string metadataURI;
        uint256 reputation;
        uint256 registeredAt;
        bool active;
    }

    /// @notice Returns the full identity record for a registered agent.
    /// @param tokenId The ERC-721 token ID of the agent.
    function getAgent(uint256 tokenId) external view returns (AgentIdentity memory);

    /// @notice Adjusts the reputation of an agent by a signed basis-point delta.
    /// @param tokenId The ERC-721 token ID of the agent.
    /// @param delta   Positive to increase reputation, negative to decrease.
    function adjustReputation(uint256 tokenId, int256 delta) external;
}

/**
 * @title IERC20
 * @notice Minimal ERC-20 interface used exclusively for USDC interactions.
 */
interface IERC20 {
    /// @notice Transfers `amount` tokens from `from` to `to` using the caller's allowance.
    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    /// @notice Transfers `amount` tokens to `to` from the caller's balance.
    function transfer(address to, uint256 amount) external returns (bool);

    /// @notice Returns the token balance of `account`.
    function balanceOf(address account) external view returns (uint256);

    /// @notice Returns the remaining allowance `spender` can spend on behalf of `owner`.
    function allowance(address owner, address spender) external view returns (uint256);
}

// =============================================================================
// AgentRetainer
// =============================================================================

/**
 * @title AgentRetainer
 * @notice Layer 5 of the Arc agentic-commerce stack.
 *
 * @dev Enables AI agents to offer recurring USDC subscription plans that
 *      clients can subscribe to. A permissionless charge() function allows
 *      anyone (keepers, the agent itself, or the client) to trigger periodic
 *      USDC transfers from the subscriber to the agent's owner.
 *
 *      Architecture overview
 *      ---------------------
 *      1. An agent owner calls createPlan() to define a subscription tier
 *         with a USDC price and billing interval.
 *      2. A client calls subscribe() to begin a subscription. The first
 *         charge happens after one full interval elapses.
 *      3. Anyone calls charge() once the interval has elapsed. The contract
 *         pulls USDC via transferFrom and rewards the agent with reputation.
 *      4. If a charge is not executed within the grace period (3 days after
 *         the interval), or if the client lacks sufficient balance/allowance,
 *         the subscription lapses automatically.
 *      5. The client may cancel at any time via cancelSubscription().
 *
 *      Reputation constants (in basis points)
 *      --------------------------------------
 *      REPUTATION_PER_CHARGE  +50 bps  awarded on each successful charge cycle
 *
 *      Grace period
 *      ------------
 *      GRACE_PERIOD  259200 seconds (3 days) — window after the interval
 *      during which a charge can still be executed before the sub lapses.
 */
contract AgentRetainer {
    // =========================================================================
    // Constants
    // =========================================================================

    /// @notice Arc's native gas token exposed via an ERC-20 interface (6 decimals).
    address public constant USDC = 0x3600000000000000000000000000000000000000;

    /// @notice Grace period after a billing interval before a subscription lapses.
    uint256 public constant GRACE_PERIOD = 259200; // 3 days in seconds

    /// @notice Reputation boost awarded to the agent on each successful charge.
    int256 public constant REPUTATION_PER_CHARGE = 50;

    // =========================================================================
    // Enums
    // =========================================================================

    /**
     * @notice Lifecycle states of a subscription Plan.
     *
     * Active      - Plan is open for new subscriptions.
     * Deactivated - Plan no longer accepts new subscribers; existing subs continue.
     */
    enum PlanStatus {
        Active,
        Deactivated
    }

    /**
     * @notice Lifecycle states of a Subscription.
     *
     * Active    - Subscription is live; charges can be executed.
     * Cancelled - Client voluntarily ended the subscription.
     * Lapsed    - Subscription expired due to missed payment or grace period.
     */
    enum SubscriptionStatus {
        Active,
        Cancelled,
        Lapsed
    }

    // =========================================================================
    // Structs
    // =========================================================================

    /**
     * @notice Represents a recurring payment plan offered by an agent.
     * @param id              Auto-incremented unique identifier.
     * @param agentTokenId    ERC-721 token ID of the agent offering this plan.
     * @param priceUsdc       USDC amount charged per billing cycle (6-decimal precision).
     * @param intervalSeconds Duration of each billing cycle in seconds (minimum 3600).
     * @param description     Human-readable description of what the plan offers.
     * @param status          Current lifecycle status of the plan.
     * @param createdAt       Block timestamp when the plan was created.
     * @param subscriberCount Number of currently active subscribers to this plan.
     */
    struct Plan {
        uint256 id;
        uint256 agentTokenId;
        uint256 priceUsdc;
        uint256 intervalSeconds;
        string description;
        PlanStatus status;
        uint256 createdAt;
        uint256 subscriberCount;
    }

    /**
     * @notice Represents a client's active subscription to a plan.
     * @param id            Auto-incremented unique identifier.
     * @param planId        The plan this subscription is attached to.
     * @param client        Address of the subscribing client.
     * @param status        Current lifecycle status of the subscription.
     * @param startedAt     Block timestamp when the subscription began.
     * @param lastChargedAt Block timestamp of the most recent charge (or subscription start).
     * @param totalCharged  Cumulative USDC charged across all cycles (6-decimal precision).
     * @param cycleCount    Number of successful charge cycles completed.
     */
    struct Subscription {
        uint256 id;
        uint256 planId;
        address client;
        SubscriptionStatus status;
        uint256 startedAt;
        uint256 lastChargedAt;
        uint256 totalCharged;
        uint256 cycleCount;
    }

    // =========================================================================
    // State Variables
    // =========================================================================

    /// @notice Reference to the Arc Agent Identity Registry (Layer 1).
    IAgentIdentity public immutable identityRegistry;

    /// @notice USDC token contract (Arc native gas token with ERC-20 interface).
    IERC20 private immutable _usdc;

    /// @notice Protocol owner (reserved for future governance or fee collection).
    address public owner;

    /// @dev Auto-incrementing counter for plan IDs; starts at 1.
    uint256 private _nextPlanId;

    /// @dev Auto-incrementing counter for subscription IDs; starts at 1.
    uint256 private _nextSubId;

    /// @notice Primary storage for plans keyed by planId.
    mapping(uint256 => Plan) public plans;

    /// @notice Primary storage for subscriptions keyed by subscriptionId.
    mapping(uint256 => Subscription) public subscriptions;

    /// @notice Reverse-lookup: agentTokenId => array of plan IDs offered by that agent.
    mapping(uint256 => uint256[]) public plansByAgent;

    /// @notice Reverse-lookup: client address => array of subscription IDs held by that client.
    mapping(address => uint256[]) public subscriptionsByClient;

    /// @notice Reverse-lookup: planId => array of subscription IDs attached to that plan.
    mapping(uint256 => uint256[]) public subscriptionsByPlan;

    // =========================================================================
    // Events
    // =========================================================================

    /// @notice Emitted when an agent creates a new subscription plan.
    event PlanCreated(
        uint256 indexed planId,
        uint256 indexed agentTokenId,
        uint256 priceUsdc,
        uint256 intervalSeconds
    );

    /// @notice Emitted when a plan's price or interval is updated.
    event PlanUpdated(
        uint256 indexed planId,
        uint256 newPriceUsdc,
        uint256 newIntervalSeconds
    );

    /// @notice Emitted when a plan is deactivated (no new subscribers).
    event PlanDeactivated(uint256 indexed planId);

    /// @notice Emitted when a client subscribes to a plan.
    event Subscribed(
        uint256 indexed subscriptionId,
        uint256 indexed planId,
        address indexed client
    );

    /// @notice Emitted when a client cancels their subscription.
    event SubscriptionCancelled(uint256 indexed subscriptionId);

    /// @notice Emitted on each successful charge of a subscription.
    event SubscriptionCharged(
        uint256 indexed subscriptionId,
        uint256 indexed planId,
        uint256 amount,
        uint256 cycleNumber
    );

    /// @notice Emitted when a subscription lapses due to missed payment or grace expiry.
    event SubscriptionLapsed(uint256 indexed subscriptionId);

    // =========================================================================
    // Constructor
    // =========================================================================

    /**
     * @notice Deploys the AgentRetainer and wires up dependencies.
     * @param _identityRegistry Address of the Arc Agent Identity Registry.
     * @param usdcAddress       Address of the USDC (ERC-20) contract.
     *                          Pass address(0) to use the canonical Arc constant.
     */
    constructor(address _identityRegistry, address usdcAddress) {
        require(
            _identityRegistry != address(0),
            "AgentRetainer: identity registry cannot be zero address"
        );

        identityRegistry = IAgentIdentity(_identityRegistry);

        // Allow the deployer to override the USDC address for testing while
        // defaulting to the Arc canonical constant when address(0) is passed.
        address resolvedUsdc = usdcAddress == address(0) ? USDC : usdcAddress;
        _usdc = IERC20(resolvedUsdc);

        owner = msg.sender;

        // IDs start at 1 so that a mapping returning 0 unambiguously means
        // "not found".
        _nextPlanId = 1;
        _nextSubId = 1;
    }

    // =========================================================================
    // Internal Helpers
    // =========================================================================

    /**
     * @dev Fetches the identity of an agent and reverts if not found / inactive.
     * @param tokenId The ERC-721 token ID of the agent.
     * @return identity The full AgentIdentity record.
     */
    function _requireActiveAgent(uint256 tokenId)
        internal
        view
        returns (IAgentIdentity.AgentIdentity memory identity)
    {
        identity = identityRegistry.getAgent(tokenId);
        require(
            identity.registeredAt != 0,
            "AgentRetainer: agent does not exist"
        );
        require(identity.active, "AgentRetainer: agent is not active");
    }

    /**
     * @dev Reverts if `msg.sender` is not the owner of the given agent.
     * @param tokenId  The agent to check ownership of.
     * @param identity Pre-fetched identity record (avoids redundant external calls).
     */
    function _requireAgentOwner(
        uint256 tokenId,
        IAgentIdentity.AgentIdentity memory identity
    ) internal view {
        require(
            identity.owner == msg.sender,
            "AgentRetainer: caller does not own agent"
        );
        // Suppress unused-variable warning -- tokenId used for contextual clarity.
        tokenId;
    }

    // =========================================================================
    // Plan Management
    // =========================================================================

    /**
     * @notice Creates a new subscription plan for an agent.
     *
     * @dev The caller must own the specified agent. The agent must be active.
     *      The plan is created in Active status and immediately available for
     *      subscriptions.
     *
     * @param agentTokenId    Token ID of the agent offering this plan.
     * @param priceUsdc       USDC amount per billing cycle (6-decimal, must be > 0).
     * @param intervalSeconds Duration of each billing cycle (must be >= 3600).
     * @param description     Human-readable description of the plan's offering.
     * @return planId         The newly assigned plan ID.
     */
    function createPlan(
        uint256 agentTokenId,
        uint256 priceUsdc,
        uint256 intervalSeconds,
        string calldata description
    ) external returns (uint256 planId) {
        // -- Validate agent -------------------------------------------------------
        IAgentIdentity.AgentIdentity memory identity = _requireActiveAgent(agentTokenId);
        _requireAgentOwner(agentTokenId, identity);

        // -- Validate plan parameters ---------------------------------------------
        require(
            priceUsdc > 0,
            "AgentRetainer: priceUsdc must be greater than zero"
        );
        require(
            intervalSeconds >= 3600,
            "AgentRetainer: intervalSeconds must be at least 3600 (1 hour)"
        );

        // -- Assign plan ID -------------------------------------------------------
        planId = _nextPlanId++;

        // -- Persist plan ---------------------------------------------------------
        plans[planId] = Plan({
            id: planId,
            agentTokenId: agentTokenId,
            priceUsdc: priceUsdc,
            intervalSeconds: intervalSeconds,
            description: description,
            status: PlanStatus.Active,
            createdAt: block.timestamp,
            subscriberCount: 0
        });

        // -- Index by agent -------------------------------------------------------
        plansByAgent[agentTokenId].push(planId);

        emit PlanCreated(planId, agentTokenId, priceUsdc, intervalSeconds);
    }

    /**
     * @notice Updates the price and/or interval of an existing plan.
     *
     * @dev Only the owner of the plan's agent may update. Changes apply
     *      to ALL subscriptions at their next charge cycle (SaaS model --
     *      existing subscribers use whatever the plan says at charge time).
     *
     * @param planId             The plan to update.
     * @param newPriceUsdc       New USDC price per cycle (must be > 0).
     * @param newIntervalSeconds New billing interval in seconds (must be >= 3600).
     */
    function updatePlan(
        uint256 planId,
        uint256 newPriceUsdc,
        uint256 newIntervalSeconds
    ) external {
        Plan storage plan = plans[planId];

        require(plan.id != 0, "AgentRetainer: plan does not exist");

        // -- Verify ownership -----------------------------------------------------
        IAgentIdentity.AgentIdentity memory identity = _requireActiveAgent(plan.agentTokenId);
        _requireAgentOwner(plan.agentTokenId, identity);

        // -- Validate new parameters ----------------------------------------------
        require(
            newPriceUsdc > 0,
            "AgentRetainer: newPriceUsdc must be greater than zero"
        );
        require(
            newIntervalSeconds >= 3600,
            "AgentRetainer: newIntervalSeconds must be at least 3600 (1 hour)"
        );

        // -- Apply updates --------------------------------------------------------
        plan.priceUsdc = newPriceUsdc;
        plan.intervalSeconds = newIntervalSeconds;

        emit PlanUpdated(planId, newPriceUsdc, newIntervalSeconds);
    }

    /**
     * @notice Deactivates a plan so no new subscriptions can be created.
     *
     * @dev Only the owner of the plan's agent may deactivate. Existing
     *      active subscriptions remain valid and can still be charged
     *      until the client cancels or the subscription lapses.
     *
     * @param planId The plan to deactivate.
     */
    function deactivatePlan(uint256 planId) external {
        Plan storage plan = plans[planId];

        require(plan.id != 0, "AgentRetainer: plan does not exist");
        require(
            plan.status == PlanStatus.Active,
            "AgentRetainer: plan is already deactivated"
        );

        // -- Verify ownership -----------------------------------------------------
        IAgentIdentity.AgentIdentity memory identity = _requireActiveAgent(plan.agentTokenId);
        _requireAgentOwner(plan.agentTokenId, identity);

        // -- Deactivate -----------------------------------------------------------
        plan.status = PlanStatus.Deactivated;

        emit PlanDeactivated(planId);
    }

    // =========================================================================
    // Subscription Management
    // =========================================================================

    /**
     * @notice Subscribe to an active plan. The first charge occurs after one
     *         full billing interval has elapsed.
     *
     * @dev The plan must be Active. The caller cannot already hold an Active
     *      subscription to the same plan. The client should approve sufficient
     *      USDC allowance for this contract before the first charge is due.
     *
     * @param planId The plan to subscribe to.
     * @return subscriptionId The newly assigned subscription ID.
     */
    function subscribe(uint256 planId) external returns (uint256 subscriptionId) {
        Plan storage plan = plans[planId];

        require(plan.id != 0, "AgentRetainer: plan does not exist");
        require(
            plan.status == PlanStatus.Active,
            "AgentRetainer: plan is not active"
        );

        // -- Check for existing active subscription to this plan ------------------
        uint256[] storage clientSubs = subscriptionsByClient[msg.sender];
        uint256 clientSubCount = clientSubs.length;
        for (uint256 i = 0; i < clientSubCount; ) {
            Subscription storage existing = subscriptions[clientSubs[i]];
            if (
                existing.planId == planId &&
                existing.status == SubscriptionStatus.Active
            ) {
                revert("AgentRetainer: client already has an active subscription to this plan");
            }
            unchecked { ++i; }
        }

        // -- Assign subscription ID -----------------------------------------------
        subscriptionId = _nextSubId++;

        // -- Persist subscription --------------------------------------------------
        subscriptions[subscriptionId] = Subscription({
            id: subscriptionId,
            planId: planId,
            client: msg.sender,
            status: SubscriptionStatus.Active,
            startedAt: block.timestamp,
            lastChargedAt: block.timestamp,
            totalCharged: 0,
            cycleCount: 0
        });

        // -- Index by client and plan ---------------------------------------------
        subscriptionsByClient[msg.sender].push(subscriptionId);
        subscriptionsByPlan[planId].push(subscriptionId);

        // -- Increment plan subscriber count --------------------------------------
        plan.subscriberCount++;

        emit Subscribed(subscriptionId, planId, msg.sender);
    }

    /**
     * @notice Cancel an active subscription. Only the subscriber may cancel.
     *
     * @dev Sets the subscription status to Cancelled and decrements the
     *      plan's active subscriber count. No refunds are issued for
     *      previously charged cycles.
     *
     * @param subscriptionId The subscription to cancel.
     */
    function cancelSubscription(uint256 subscriptionId) external {
        Subscription storage sub = subscriptions[subscriptionId];

        require(sub.id != 0, "AgentRetainer: subscription does not exist");
        require(
            sub.client == msg.sender,
            "AgentRetainer: caller is not the subscriber"
        );
        require(
            sub.status == SubscriptionStatus.Active,
            "AgentRetainer: subscription is not active"
        );

        // -- Cancel ---------------------------------------------------------------
        sub.status = SubscriptionStatus.Cancelled;

        // -- Decrement plan subscriber count --------------------------------------
        Plan storage plan = plans[sub.planId];
        if (plan.subscriberCount > 0) {
            plan.subscriberCount--;
        }

        emit SubscriptionCancelled(subscriptionId);
    }

    // =========================================================================
    // Charging
    // =========================================================================

    /**
     * @notice Execute a charge on a subscription. PERMISSIONLESS -- anyone can call.
     *
     * @dev Conditions for a successful charge:
     *      1. Subscription must be Active.
     *      2. At least one full interval must have elapsed since lastChargedAt.
     *      3. If more than interval + GRACE_PERIOD has elapsed, the subscription
     *         lapses instead of being charged.
     *      4. The client must have sufficient USDC balance and allowance for this
     *         contract. If the transferFrom fails, the subscription lapses.
     *
     *      On success:
     *      - USDC is transferred from client to the agent's current owner.
     *      - lastChargedAt, totalCharged, and cycleCount are updated.
     *      - The agent receives a reputation boost via adjustReputation().
     *
     * @param subscriptionId The subscription to charge.
     */
    function charge(uint256 subscriptionId) external {
        Subscription storage sub = subscriptions[subscriptionId];

        require(sub.id != 0, "AgentRetainer: subscription does not exist");
        require(
            sub.status == SubscriptionStatus.Active,
            "AgentRetainer: subscription is not active"
        );

        Plan storage plan = plans[sub.planId];

        // -- Check that at least one interval has elapsed -------------------------
        uint256 nextChargeTime = sub.lastChargedAt + plan.intervalSeconds;
        require(
            block.timestamp >= nextChargeTime,
            "AgentRetainer: billing interval has not elapsed"
        );

        // -- Check grace period -- if exceeded, lapse the subscription ------------
        uint256 lapseCutoff = nextChargeTime + GRACE_PERIOD;
        if (block.timestamp > lapseCutoff) {
            sub.status = SubscriptionStatus.Lapsed;
            if (plan.subscriberCount > 0) {
                plan.subscriberCount--;
            }
            emit SubscriptionLapsed(subscriptionId);
            return;
        }

        // -- Resolve the agent's current owner for payment ------------------------
        IAgentIdentity.AgentIdentity memory agentIdentity = identityRegistry.getAgent(
            plan.agentTokenId
        );
        address agentOwner = agentIdentity.owner;

        // -- Attempt USDC transfer from client to agent owner ---------------------
        bool transferred = _usdc.transferFrom(sub.client, agentOwner, plan.priceUsdc);
        if (!transferred) {
            // Insufficient balance or allowance -- lapse the subscription
            sub.status = SubscriptionStatus.Lapsed;
            if (plan.subscriberCount > 0) {
                plan.subscriberCount--;
            }
            emit SubscriptionLapsed(subscriptionId);
            return;
        }

        // -- Update subscription state --------------------------------------------
        sub.lastChargedAt = block.timestamp;
        sub.totalCharged += plan.priceUsdc;
        sub.cycleCount++;

        // -- Reward agent reputation ----------------------------------------------
        identityRegistry.adjustReputation(plan.agentTokenId, REPUTATION_PER_CHARGE);

        emit SubscriptionCharged(
            subscriptionId,
            sub.planId,
            plan.priceUsdc,
            sub.cycleCount
        );
    }

    // =========================================================================
    // View Functions
    // =========================================================================

    /**
     * @notice Returns the full Plan record for a given ID.
     * @param planId The plan to query.
     * @return The Plan struct (callers should check `id != 0` for existence).
     */
    function getPlan(uint256 planId) external view returns (Plan memory) {
        return plans[planId];
    }

    /**
     * @notice Returns the full Subscription record for a given ID.
     * @param subscriptionId The subscription to query.
     * @return The Subscription struct (callers should check `id != 0` for existence).
     */
    function getSubscription(uint256 subscriptionId) external view returns (Subscription memory) {
        return subscriptions[subscriptionId];
    }

    /**
     * @notice Returns all plan IDs offered by a given agent.
     * @param agentTokenId The agent to query.
     * @return Array of plan IDs.
     */
    function getPlansByAgent(uint256 agentTokenId) external view returns (uint256[] memory) {
        return plansByAgent[agentTokenId];
    }

    /**
     * @notice Returns all subscription IDs held by a given client address.
     * @param client The client address to query.
     * @return Array of subscription IDs.
     */
    function getSubscriptionsByClient(address client) external view returns (uint256[] memory) {
        return subscriptionsByClient[client];
    }

    /**
     * @notice Returns all subscription IDs attached to a given plan.
     * @param planId The plan to query.
     * @return Array of subscription IDs.
     */
    function getSubscriptionsByPlan(uint256 planId) external view returns (uint256[] memory) {
        return subscriptionsByPlan[planId];
    }

    /**
     * @notice Returns the number of currently active subscribers for a plan.
     * @param planId The plan to query.
     * @return count The current active subscriber count.
     */
    function getActiveSubscriptionCount(uint256 planId) external view returns (uint256 count) {
        return plans[planId].subscriberCount;
    }
}

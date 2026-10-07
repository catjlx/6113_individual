// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RentalDepositEscrow
 * @notice Holds tenants' rental deposits so that neither the landlord nor the tenant can
 *         move the money unilaterally. The contract is the only custodian of the funds.
 *
 * Roles (decided by address, not by who owns the wallet):
 *   - Landlord : creates the lease, may propose a deduction after the lease ends.
 *   - Tenant   : pays the deposit, may accept or reject a proposed deduction.
 *   - Arbiter  : the platform (the deployer). Only acts when a deduction is disputed.
 *
 * Happy path / default rules (the contract cannot force anyone to act, so silence has a
 * defined outcome instead):
 *
 *   Created --payDeposit--> Funded --(lease ends)--+--releaseDeposit--------------> Settled (full refund)
 *      |                                            |
 *      +--cancelLease--> Cancelled                  +--landlord silent for proposalWindow
 *                                                   |      --claimByTimeout-------> Settled (full refund)
 *                                                   |
 *                                                   +--proposeDeduction--> DeductionProposed
 *                                                          |--acceptDeduction----------------> Settled (as proposed)
 *                                                          |--tenant silent for responseWindow
 *                                                          |      --claimByTimeout----------> Settled (as proposed)
 *                                                          +--rejectDeduction--> Disputed
 *                                                                 --resolveDispute (arbiter)--> Settled
 *
 * Money never leaves the contract during settlement. Settlement only credits internal
 * balances; each party then calls {withdraw} (pull-payment pattern).
 */
contract RentalDepositEscrow is ReentrancyGuard {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Status {
        Created, // landlord created the lease, waiting for the deposit
        Funded, // deposit is held by the contract
        DeductionProposed, // landlord asked to keep part of the deposit
        Disputed, // tenant rejected the deduction, waiting for the arbiter
        Settled, // final split has been credited
        Cancelled // lease cancelled before the deposit was paid
    }

    enum SettlementType {
        FullRefundByLandlord,
        FullRefundByTimeout,
        DeductionAccepted,
        DeductionBySilence,
        Arbitrated
    }

    // Field order is chosen so that the struct packs into 4 storage slots + 2 hashes.
    struct Lease {
        address landlord; // slot 0: 20 bytes
        uint64 startTime; //         8 bytes
        Status status; //            1 byte
        address tenant; // slot 1: 20 bytes
        uint64 endTime; //           8 bytes
        uint128 depositAmount; // slot 2: wei
        uint128 deductionAmount; //      wei claimed by the landlord
        uint64 proposedAt; // slot 3: timestamp of the deduction proposal
        uint32 proposalWindow; //     seconds the landlord has after endTime to propose
        uint32 responseWindow; //     seconds the tenant has to answer a proposal
        bytes32 conditionReportHash; // slot 4: hash of the move-in condition report
        bytes32 evidenceHash; //        slot 5: hash of the landlord's deduction evidence
    }

    // Input struct for createLease; one calldata struct keeps the ABI explicit.
    struct LeaseTerms {
        address tenant;
        uint128 depositAmount;
        uint64 startTime;
        uint64 endTime;
        uint32 proposalWindow;
        uint32 responseWindow;
        bytes32 conditionReportHash;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice Platform account that arbitrates disputes (the deployer).
    address public immutable arbiter;

    /// @notice Number of leases created; lease ids start at 1.
    uint256 public leaseCount;

    /// @notice Minimum / maximum length of the proposal and response windows.
    /// @dev The minimum is deliberately short so a demo on a testnet can run in minutes.
    ///      A production deployment would use a much larger minimum (e.g. 1 day).
    uint32 public constant MIN_WINDOW = 60; // 1 minute
    uint32 public constant MAX_WINDOW = 90 days;

    mapping(uint256 => Lease) private _leases;

    /// @notice Credited but not yet withdrawn balances (pull payments).
    mapping(address => uint256) public pendingWithdrawals;

    // ---------------------------------------------------------------------
    // Events (the backend rebuilds the history from these)
    // ---------------------------------------------------------------------

    event LeaseCreated(
        uint256 indexed leaseId,
        address indexed landlord,
        address indexed tenant,
        uint128 depositAmount,
        uint64 startTime,
        uint64 endTime,
        bytes32 conditionReportHash
    );
    event DepositPaid(uint256 indexed leaseId, address indexed tenant, uint256 amount);
    event LeaseCancelled(uint256 indexed leaseId, address indexed by);
    event DeductionProposed(
        uint256 indexed leaseId,
        uint128 amount,
        bytes32 evidenceHash,
        uint256 responseDeadline
    );
    event DeductionRejected(uint256 indexed leaseId, address indexed tenant);
    event LeaseSettled(
        uint256 indexed leaseId,
        uint256 landlordAmount,
        uint256 tenantAmount,
        SettlementType settlementType
    );
    event Withdrawn(address indexed account, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors (custom errors are cheaper than revert strings and carry data)
    // ---------------------------------------------------------------------

    error LeaseNotFound(uint256 leaseId);
    error NotLandlord();
    error NotTenant();
    error NotParty();
    error NotArbiter();
    error InvalidStatus(Status current, Status expected);
    error ArbiterCannotBeParty();
    error InvalidTenant();
    error InvalidAmount();
    error InvalidTime();
    error InvalidWindow();
    error EmptyHash();
    error WrongDepositAmount(uint256 expected, uint256 sent);
    error ConditionReportMismatch();
    error LeaseAlreadyEnded();
    error LeaseNotEnded(uint256 endTime);
    error ProposalWindowClosed(uint256 deadline);
    error ResponseWindowClosed(uint256 deadline);
    error TimeoutNotReached(uint256 deadline);
    error AwardExceedsClaim(uint256 claimed, uint256 awarded);
    error NothingToWithdraw();
    error TransferFailed();

    // ---------------------------------------------------------------------
    // Modifiers (authentication / authorization)
    // ---------------------------------------------------------------------

    modifier onlyLandlord(uint256 leaseId) {
        if (msg.sender != _lease(leaseId).landlord) revert NotLandlord();
        _;
    }

    modifier onlyTenant(uint256 leaseId) {
        if (msg.sender != _lease(leaseId).tenant) revert NotTenant();
        _;
    }

    modifier onlyParty(uint256 leaseId) {
        Lease storage l = _lease(leaseId);
        if (msg.sender != l.landlord && msg.sender != l.tenant) revert NotParty();
        _;
    }

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }

    modifier inStatus(uint256 leaseId, Status expected) {
        Status current = _lease(leaseId).status;
        if (current != expected) revert InvalidStatus(current, expected);
        _;
    }

    constructor() {
        arbiter = msg.sender;
    }

    // ---------------------------------------------------------------------
    // Lease lifecycle
    // ---------------------------------------------------------------------

    /// @notice Landlord opens a lease. The deposit is NOT collected yet.
    function createLease(LeaseTerms calldata t) external returns (uint256 leaseId) {
        if (msg.sender == arbiter) revert ArbiterCannotBeParty();
        if (t.tenant == address(0) || t.tenant == msg.sender || t.tenant == arbiter) {
            revert InvalidTenant();
        }
        if (t.depositAmount == 0) revert InvalidAmount();
        if (t.endTime <= t.startTime || t.endTime <= block.timestamp) revert InvalidTime();
        if (!_validWindow(t.proposalWindow) || !_validWindow(t.responseWindow)) {
            revert InvalidWindow();
        }
        if (t.conditionReportHash == bytes32(0)) revert EmptyHash();

        leaseId = ++leaseCount;

        Lease storage l = _leases[leaseId];
        l.landlord = msg.sender;
        l.tenant = t.tenant;
        l.depositAmount = t.depositAmount;
        l.startTime = t.startTime;
        l.endTime = t.endTime;
        l.proposalWindow = t.proposalWindow;
        l.responseWindow = t.responseWindow;
        l.conditionReportHash = t.conditionReportHash;
        // l.status is Status.Created (0) by default

        emit LeaseCreated(
            leaseId,
            msg.sender,
            t.tenant,
            t.depositAmount,
            t.startTime,
            t.endTime,
            t.conditionReportHash
        );
    }

    /// @notice Tenant pays the exact deposit into the contract.
    /// @param conditionReportHash Must equal the landlord's move-in condition report hash.
    ///        Passing the matching hash is the tenant's on-chain acknowledgement of the
    ///        baseline condition of the property.
    function payDeposit(uint256 leaseId, bytes32 conditionReportHash)
        external
        payable
        onlyTenant(leaseId)
        inStatus(leaseId, Status.Created)
    {
        Lease storage l = _leases[leaseId];
        if (block.timestamp >= l.endTime) revert LeaseAlreadyEnded();
        if (msg.value != l.depositAmount) revert WrongDepositAmount(l.depositAmount, msg.value);
        if (conditionReportHash != l.conditionReportHash) revert ConditionReportMismatch();

        l.status = Status.Funded;
        emit DepositPaid(leaseId, msg.sender, msg.value);
    }

    /// @notice Either party may cancel a lease whose deposit has not been paid yet.
    function cancelLease(uint256 leaseId)
        external
        onlyParty(leaseId)
        inStatus(leaseId, Status.Created)
    {
        _leases[leaseId].status = Status.Cancelled;
        emit LeaseCancelled(leaseId, msg.sender);
    }

    /// @notice Landlord returns the full deposit after the lease has ended.
    function releaseDeposit(uint256 leaseId)
        external
        onlyLandlord(leaseId)
        inStatus(leaseId, Status.Funded)
    {
        uint64 endTime = _leases[leaseId].endTime;
        if (block.timestamp < endTime) revert LeaseNotEnded(endTime);
        _settle(leaseId, 0, SettlementType.FullRefundByLandlord);
    }

    /// @notice Landlord asks to keep `amount` wei, inside the proposal window.
    /// @param evidenceHash Hash of the evidence file (kept off-chain, e.g. photos, invoices).
    function proposeDeduction(uint256 leaseId, uint128 amount, bytes32 evidenceHash)
        external
        onlyLandlord(leaseId)
        inStatus(leaseId, Status.Funded)
    {
        Lease storage l = _leases[leaseId];
        if (block.timestamp < l.endTime) revert LeaseNotEnded(l.endTime);
        uint256 proposalDeadline = uint256(l.endTime) + l.proposalWindow;
        if (block.timestamp > proposalDeadline) revert ProposalWindowClosed(proposalDeadline);
        if (amount == 0 || amount > l.depositAmount) revert InvalidAmount();
        if (evidenceHash == bytes32(0)) revert EmptyHash();

        l.deductionAmount = amount;
        l.evidenceHash = evidenceHash;
        l.proposedAt = uint64(block.timestamp);
        l.status = Status.DeductionProposed;

        emit DeductionProposed(leaseId, amount, evidenceHash, block.timestamp + l.responseWindow);
    }

    /// @notice Tenant agrees to the proposed deduction; settles immediately.
    function acceptDeduction(uint256 leaseId)
        external
        onlyTenant(leaseId)
        inStatus(leaseId, Status.DeductionProposed)
    {
        _settle(leaseId, _leases[leaseId].deductionAmount, SettlementType.DeductionAccepted);
    }

    /// @notice Tenant rejects the proposal; only possible inside the response window.
    ///         After the window, silence counts as consent (see {claimByTimeout}).
    function rejectDeduction(uint256 leaseId)
        external
        onlyTenant(leaseId)
        inStatus(leaseId, Status.DeductionProposed)
    {
        Lease storage l = _leases[leaseId];
        uint256 responseDeadline = uint256(l.proposedAt) + l.responseWindow;
        if (block.timestamp > responseDeadline) revert ResponseWindowClosed(responseDeadline);

        l.status = Status.Disputed;
        emit DeductionRejected(leaseId, msg.sender);
    }

    /// @notice Arbiter decides how much of the claimed deduction the landlord receives.
    ///         The tenant receives the rest of the deposit.
    /// @dev The award can never exceed what the landlord claimed.
    function resolveDispute(uint256 leaseId, uint128 landlordAmount)
        external
        onlyArbiter
        inStatus(leaseId, Status.Disputed)
    {
        uint128 claimed = _leases[leaseId].deductionAmount;
        if (landlordAmount > claimed) revert AwardExceedsClaim(claimed, landlordAmount);
        _settle(leaseId, landlordAmount, SettlementType.Arbitrated);
    }

    /// @notice Applies the default outcome once a deadline has passed. Callable by anyone,
    ///         because the result is fully determined by the stored terms.
    ///           - Funded + landlord never proposed in time  -> full refund to the tenant
    ///           - DeductionProposed + tenant never answered -> deduction applies as proposed
    function claimByTimeout(uint256 leaseId) external {
        Lease storage l = _lease(leaseId);

        if (l.status == Status.Funded) {
            uint256 proposalDeadline = uint256(l.endTime) + l.proposalWindow;
            if (block.timestamp <= proposalDeadline) revert TimeoutNotReached(proposalDeadline);
            _settle(leaseId, 0, SettlementType.FullRefundByTimeout);
        } else if (l.status == Status.DeductionProposed) {
            uint256 responseDeadline = uint256(l.proposedAt) + l.responseWindow;
            if (block.timestamp <= responseDeadline) revert TimeoutNotReached(responseDeadline);
            _settle(leaseId, l.deductionAmount, SettlementType.DeductionBySilence);
        } else {
            revert InvalidStatus(l.status, Status.Funded);
        }
    }

    // ---------------------------------------------------------------------
    // Pull payment
    // ---------------------------------------------------------------------

    /// @notice Withdraw everything credited to the caller.
    /// @dev Checks-effects-interactions: the balance is zeroed before the external call,
    ///      and {nonReentrant} blocks re-entry as a second line of defence.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        pendingWithdrawals[msg.sender] = 0;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getLease(uint256 leaseId) external view returns (Lease memory) {
        return _lease(leaseId);
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _lease(uint256 leaseId) private view returns (Lease storage l) {
        l = _leases[leaseId];
        if (l.landlord == address(0)) revert LeaseNotFound(leaseId);
    }

    function _validWindow(uint32 window) private pure returns (bool) {
        return window >= MIN_WINDOW && window <= MAX_WINDOW;
    }

    /// @dev Credits the split to internal balances. No ether leaves the contract here.
    function _settle(uint256 leaseId, uint128 landlordAmount, SettlementType how) private {
        Lease storage l = _leases[leaseId];
        uint128 tenantAmount = l.depositAmount - landlordAmount;

        l.status = Status.Settled;
        if (landlordAmount > 0) pendingWithdrawals[l.landlord] += landlordAmount;
        if (tenantAmount > 0) pendingWithdrawals[l.tenant] += tenantAmount;

        emit LeaseSettled(leaseId, landlordAmount, tenantAmount, how);
    }
}

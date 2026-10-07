const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

// ---------------------------------------------------------------------------
// Constants mirrored from the contract
// ---------------------------------------------------------------------------
const DAY = 24 * 60 * 60;
const MIN_WINDOW = 60;
const MAX_WINDOW = 90 * DAY;

const Status = { Created: 0, Funded: 1, DeductionProposed: 2, Disputed: 3, Settled: 4, Cancelled: 5 };
const SType = {
  FullRefundByLandlord: 0,
  FullRefundByTimeout: 1,
  DeductionAccepted: 2,
  DeductionBySilence: 3,
  Arbitrated: 4,
};

const DEPOSIT = ethers.parseEther("0.5");
const DEDUCTION = ethers.parseEther("0.2");
const PROPOSAL_WINDOW = 3 * DAY;
const RESPONSE_WINDOW = 3 * DAY;
const REPORT_HASH = ethers.keccak256(ethers.toUtf8Bytes("move-in condition report v1"));
const EVIDENCE_HASH = ethers.keccak256(ethers.toUtf8Bytes("damage photos + invoice"));

// ---------------------------------------------------------------------------
// Helpers and fixtures. Each fixture builds on the previous one by plain function calls.
// ---------------------------------------------------------------------------
async function makeTerms(tenantAddress, overrides = {}) {
  const now = await time.latest();
  return {
    tenant: tenantAddress,
    depositAmount: DEPOSIT,
    startTime: now,
    endTime: now + 30 * DAY,
    proposalWindow: PROPOSAL_WINDOW,
    responseWindow: RESPONSE_WINDOW,
    conditionReportHash: REPORT_HASH,
    ...overrides,
  };
}

async function deployFixture() {
  // signer 0 deploys, so it is the arbiter (the "platform")
  const [arbiter, landlord, tenant, other, stranger] = await ethers.getSigners();
  const Escrow = await ethers.getContractFactory("RentalDepositEscrow", arbiter);
  const escrow = await Escrow.deploy();
  await escrow.waitForDeployment();
  return { escrow, arbiter, landlord, tenant, other, stranger };
}

async function createdFixture() {
  const ctx = await deployFixture();
  const terms = await makeTerms(ctx.tenant.address);
  await ctx.escrow.connect(ctx.landlord).createLease(terms);
  return { ...ctx, terms, endTime: terms.endTime };
}

async function fundedFixture() {
  const ctx = await createdFixture();
  await ctx.escrow.connect(ctx.tenant).payDeposit(1, REPORT_HASH, { value: DEPOSIT });
  return ctx;
}

async function endedFixture() {
  const ctx = await fundedFixture();
  await time.increaseTo(ctx.endTime);
  return ctx;
}

async function proposedFixture() {
  const ctx = await endedFixture();
  await ctx.escrow.connect(ctx.landlord).proposeDeduction(1, DEDUCTION, EVIDENCE_HASH);
  const lease = await ctx.escrow.getLease(1);
  return { ...ctx, proposedAt: Number(lease.proposedAt) };
}

async function disputedFixture() {
  const ctx = await proposedFixture();
  await ctx.escrow.connect(ctx.tenant).rejectDeduction(1);
  return ctx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("RentalDepositEscrow", function () {
  describe("deployment", function () {
    it("makes the deployer the arbiter and starts with no leases", async function () {
      const { escrow, arbiter } = await loadFixture(deployFixture);
      expect(await escrow.arbiter()).to.equal(arbiter.address);
      expect(await escrow.leaseCount()).to.equal(0);
      expect(await escrow.MIN_WINDOW()).to.equal(MIN_WINDOW);
      expect(await escrow.MAX_WINDOW()).to.equal(MAX_WINDOW);
    });

    it("rejects plain ether transfers (no receive/fallback)", async function () {
      const { escrow, stranger } = await loadFixture(deployFixture);
      await expect(stranger.sendTransaction({ to: escrow.target, value: 1n })).to.be.reverted;
    });
  });

  describe("createLease", function () {
    it("stores the terms and emits LeaseCreated", async function () {
      const { escrow, landlord, tenant } = await loadFixture(deployFixture);
      const terms = await makeTerms(tenant.address);

      await expect(escrow.connect(landlord).createLease(terms))
        .to.emit(escrow, "LeaseCreated")
        .withArgs(1, landlord.address, tenant.address, DEPOSIT, terms.startTime, terms.endTime, REPORT_HASH);

      const lease = await escrow.getLease(1);
      expect(lease.landlord).to.equal(landlord.address);
      expect(lease.tenant).to.equal(tenant.address);
      expect(lease.depositAmount).to.equal(DEPOSIT);
      expect(lease.endTime).to.equal(terms.endTime);
      expect(lease.proposalWindow).to.equal(PROPOSAL_WINDOW);
      expect(lease.responseWindow).to.equal(RESPONSE_WINDOW);
      expect(lease.conditionReportHash).to.equal(REPORT_HASH);
      expect(lease.status).to.equal(Status.Created);
      expect(await escrow.leaseCount()).to.equal(1);
    });

    it("gives each lease its own incrementing id", async function () {
      const { escrow, landlord, tenant, other } = await loadFixture(deployFixture);
      await escrow.connect(landlord).createLease(await makeTerms(tenant.address));
      await escrow.connect(landlord).createLease(await makeTerms(other.address));
      expect(await escrow.leaseCount()).to.equal(2);
      expect((await escrow.getLease(2)).tenant).to.equal(other.address);
    });

    describe("rejects invalid input", function () {
      const cases = [
        ["zero tenant address", async (c) => makeTerms(ethers.ZeroAddress), "InvalidTenant"],
        ["tenant equal to landlord", async (c) => makeTerms(c.landlord.address), "InvalidTenant"],
        ["tenant equal to arbiter", async (c) => makeTerms(c.arbiter.address), "InvalidTenant"],
        ["zero deposit", async (c) => makeTerms(c.tenant.address, { depositAmount: 0n }), "InvalidAmount"],
        [
          "end time equal to start time",
          async (c) => {
            const now = await time.latest();
            return makeTerms(c.tenant.address, { startTime: now + 100, endTime: now + 100 });
          },
          "InvalidTime",
        ],
        [
          "end time in the past",
          async (c) => {
            const now = await time.latest();
            return makeTerms(c.tenant.address, { startTime: now - 2 * DAY, endTime: now - DAY });
          },
          "InvalidTime",
        ],
        ["proposal window below minimum", async (c) => makeTerms(c.tenant.address, { proposalWindow: MIN_WINDOW - 1 }), "InvalidWindow"],
        ["proposal window above maximum", async (c) => makeTerms(c.tenant.address, { proposalWindow: MAX_WINDOW + 1 }), "InvalidWindow"],
        ["response window below minimum", async (c) => makeTerms(c.tenant.address, { responseWindow: 0 }), "InvalidWindow"],
        ["response window above maximum", async (c) => makeTerms(c.tenant.address, { responseWindow: MAX_WINDOW + 1 }), "InvalidWindow"],
        ["empty condition report hash", async (c) => makeTerms(c.tenant.address, { conditionReportHash: ethers.ZeroHash }), "EmptyHash"],
      ];

      for (const [name, build, errorName] of cases) {
        it(name, async function () {
          const ctx = await loadFixture(deployFixture);
          const terms = await build(ctx);
          await expect(ctx.escrow.connect(ctx.landlord).createLease(terms)).to.be.revertedWithCustomError(
            ctx.escrow,
            errorName
          );
        });
      }

      it("the arbiter acting as landlord", async function () {
        const { escrow, arbiter, tenant } = await loadFixture(deployFixture);
        await expect(escrow.connect(arbiter).createLease(await makeTerms(tenant.address))).to.be.revertedWithCustomError(
          escrow,
          "ArbiterCannotBeParty"
        );
      });

      it("accepts the exact window boundaries", async function () {
        const { escrow, landlord, tenant } = await loadFixture(deployFixture);
        const terms = await makeTerms(tenant.address, { proposalWindow: MIN_WINDOW, responseWindow: MAX_WINDOW });
        await expect(escrow.connect(landlord).createLease(terms)).to.emit(escrow, "LeaseCreated");
      });
    });
  });

  describe("payDeposit", function () {
    it("holds the deposit in the contract and marks the lease Funded", async function () {
      const { escrow, tenant } = await loadFixture(createdFixture);

      await expect(escrow.connect(tenant).payDeposit(1, REPORT_HASH, { value: DEPOSIT }))
        .to.emit(escrow, "DepositPaid")
        .withArgs(1, tenant.address, DEPOSIT);

      expect((await escrow.getLease(1)).status).to.equal(Status.Funded);
      expect(await ethers.provider.getBalance(escrow.target)).to.equal(DEPOSIT);
    });

    it("moves the money from the tenant to the contract", async function () {
      const { escrow, tenant } = await loadFixture(createdFixture);
      await expect(
        escrow.connect(tenant).payDeposit(1, REPORT_HASH, { value: DEPOSIT })
      ).to.changeEtherBalances([tenant, escrow], [-DEPOSIT, DEPOSIT]);
    });

    it("rejects an amount that is too low or too high", async function () {
      const { escrow, tenant } = await loadFixture(createdFixture);
      const low = DEPOSIT - 1n;
      const high = DEPOSIT + 1n;
      await expect(escrow.connect(tenant).payDeposit(1, REPORT_HASH, { value: low }))
        .to.be.revertedWithCustomError(escrow, "WrongDepositAmount")
        .withArgs(DEPOSIT, low);
      await expect(escrow.connect(tenant).payDeposit(1, REPORT_HASH, { value: high }))
        .to.be.revertedWithCustomError(escrow, "WrongDepositAmount")
        .withArgs(DEPOSIT, high);
      await expect(escrow.connect(tenant).payDeposit(1, REPORT_HASH, { value: 0 }))
        .to.be.revertedWithCustomError(escrow, "WrongDepositAmount")
        .withArgs(DEPOSIT, 0);
    });

    it("rejects anyone who is not the tenant", async function () {
      const { escrow, landlord, stranger } = await loadFixture(createdFixture);
      await expect(escrow.connect(stranger).payDeposit(1, REPORT_HASH, { value: DEPOSIT })).to.be.revertedWithCustomError(
        escrow,
        "NotTenant"
      );
      await expect(escrow.connect(landlord).payDeposit(1, REPORT_HASH, { value: DEPOSIT })).to.be.revertedWithCustomError(
        escrow,
        "NotTenant"
      );
    });

    it("rejects a condition report hash that differs from the landlord's", async function () {
      const { escrow, tenant } = await loadFixture(createdFixture);
      const wrong = ethers.keccak256(ethers.toUtf8Bytes("some other report"));
      await expect(escrow.connect(tenant).payDeposit(1, wrong, { value: DEPOSIT })).to.be.revertedWithCustomError(
        escrow,
        "ConditionReportMismatch"
      );
    });

    it("cannot be paid twice", async function () {
      const { escrow, tenant } = await loadFixture(fundedFixture);
      await expect(escrow.connect(tenant).payDeposit(1, REPORT_HASH, { value: DEPOSIT }))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(Status.Funded, Status.Created);
    });

    it("cannot be paid after the lease has ended", async function () {
      const { escrow, tenant, endTime } = await loadFixture(createdFixture);
      await time.increaseTo(endTime);
      await expect(escrow.connect(tenant).payDeposit(1, REPORT_HASH, { value: DEPOSIT })).to.be.revertedWithCustomError(
        escrow,
        "LeaseAlreadyEnded"
      );
    });

    it("rejects an unknown lease id", async function () {
      const { escrow, tenant } = await loadFixture(createdFixture);
      await expect(escrow.connect(tenant).payDeposit(99, REPORT_HASH, { value: DEPOSIT }))
        .to.be.revertedWithCustomError(escrow, "LeaseNotFound")
        .withArgs(99);
    });
  });

  describe("cancelLease", function () {
    it("lets the landlord cancel before the deposit is paid", async function () {
      const { escrow, landlord } = await loadFixture(createdFixture);
      await expect(escrow.connect(landlord).cancelLease(1)).to.emit(escrow, "LeaseCancelled").withArgs(1, landlord.address);
      expect((await escrow.getLease(1)).status).to.equal(Status.Cancelled);
    });

    it("lets the tenant decline before paying", async function () {
      const { escrow, tenant } = await loadFixture(createdFixture);
      await expect(escrow.connect(tenant).cancelLease(1)).to.emit(escrow, "LeaseCancelled").withArgs(1, tenant.address);
    });

    it("rejects outsiders", async function () {
      const { escrow, stranger } = await loadFixture(createdFixture);
      await expect(escrow.connect(stranger).cancelLease(1)).to.be.revertedWithCustomError(escrow, "NotParty");
    });

    it("is impossible once the deposit is held", async function () {
      const { escrow, landlord } = await loadFixture(fundedFixture);
      await expect(escrow.connect(landlord).cancelLease(1))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(Status.Funded, Status.Created);
    });

    it("makes a cancelled lease unpayable", async function () {
      const { escrow, landlord, tenant } = await loadFixture(createdFixture);
      await escrow.connect(landlord).cancelLease(1);
      await expect(escrow.connect(tenant).payDeposit(1, REPORT_HASH, { value: DEPOSIT }))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(Status.Cancelled, Status.Created);
    });
  });

  describe("releaseDeposit (landlord returns everything)", function () {
    it("is rejected before the lease ends", async function () {
      const { escrow, landlord, endTime } = await loadFixture(fundedFixture);
      await expect(escrow.connect(landlord).releaseDeposit(1))
        .to.be.revertedWithCustomError(escrow, "LeaseNotEnded")
        .withArgs(endTime);
    });

    it("is rejected for anyone but the landlord", async function () {
      const { escrow, tenant, stranger } = await loadFixture(endedFixture);
      await expect(escrow.connect(tenant).releaseDeposit(1)).to.be.revertedWithCustomError(escrow, "NotLandlord");
      await expect(escrow.connect(stranger).releaseDeposit(1)).to.be.revertedWithCustomError(escrow, "NotLandlord");
    });

    it("credits the whole deposit to the tenant, who can then withdraw it", async function () {
      const { escrow, landlord, tenant } = await loadFixture(endedFixture);

      await expect(escrow.connect(landlord).releaseDeposit(1))
        .to.emit(escrow, "LeaseSettled")
        .withArgs(1, 0, DEPOSIT, SType.FullRefundByLandlord);

      expect((await escrow.getLease(1)).status).to.equal(Status.Settled);
      expect(await escrow.pendingWithdrawals(tenant.address)).to.equal(DEPOSIT);
      expect(await escrow.pendingWithdrawals(landlord.address)).to.equal(0);

      await expect(escrow.connect(tenant).withdraw()).to.changeEtherBalances([tenant, escrow], [DEPOSIT, -DEPOSIT]);
    });

    it("cannot be done twice", async function () {
      const { escrow, landlord } = await loadFixture(endedFixture);
      await escrow.connect(landlord).releaseDeposit(1);
      await expect(escrow.connect(landlord).releaseDeposit(1))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(Status.Settled, Status.Funded);
    });
  });

  describe("proposeDeduction", function () {
    it("is rejected before the lease ends", async function () {
      const { escrow, landlord, endTime } = await loadFixture(fundedFixture);
      await expect(escrow.connect(landlord).proposeDeduction(1, DEDUCTION, EVIDENCE_HASH))
        .to.be.revertedWithCustomError(escrow, "LeaseNotEnded")
        .withArgs(endTime);
    });

    it("is rejected for anyone but the landlord", async function () {
      const { escrow, tenant, stranger } = await loadFixture(endedFixture);
      await expect(escrow.connect(tenant).proposeDeduction(1, DEDUCTION, EVIDENCE_HASH)).to.be.revertedWithCustomError(
        escrow,
        "NotLandlord"
      );
      await expect(escrow.connect(stranger).proposeDeduction(1, DEDUCTION, EVIDENCE_HASH)).to.be.revertedWithCustomError(
        escrow,
        "NotLandlord"
      );
    });

    it("records the claim and emits DeductionProposed", async function () {
      const { escrow, landlord } = await loadFixture(endedFixture);

      await expect(escrow.connect(landlord).proposeDeduction(1, DEDUCTION, EVIDENCE_HASH))
        .to.emit(escrow, "DeductionProposed")
        .withArgs(1, DEDUCTION, EVIDENCE_HASH, anyValue);

      const lease = await escrow.getLease(1);
      expect(lease.status).to.equal(Status.DeductionProposed);
      expect(lease.deductionAmount).to.equal(DEDUCTION);
      expect(lease.evidenceHash).to.equal(EVIDENCE_HASH);
      expect(lease.proposedAt).to.equal(await time.latest());
    });

    it("rejects a zero amount and an amount above the deposit", async function () {
      const { escrow, landlord } = await loadFixture(endedFixture);
      await expect(escrow.connect(landlord).proposeDeduction(1, 0, EVIDENCE_HASH)).to.be.revertedWithCustomError(
        escrow,
        "InvalidAmount"
      );
      await expect(escrow.connect(landlord).proposeDeduction(1, DEPOSIT + 1n, EVIDENCE_HASH)).to.be.revertedWithCustomError(
        escrow,
        "InvalidAmount"
      );
    });

    it("allows claiming exactly the whole deposit", async function () {
      const { escrow, landlord } = await loadFixture(endedFixture);
      await expect(escrow.connect(landlord).proposeDeduction(1, DEPOSIT, EVIDENCE_HASH)).to.emit(escrow, "DeductionProposed");
    });

    it("requires evidence", async function () {
      const { escrow, landlord } = await loadFixture(endedFixture);
      await expect(escrow.connect(landlord).proposeDeduction(1, DEDUCTION, ethers.ZeroHash)).to.be.revertedWithCustomError(
        escrow,
        "EmptyHash"
      );
    });

    it("cannot be proposed twice", async function () {
      const { escrow, landlord } = await loadFixture(proposedFixture);
      await expect(escrow.connect(landlord).proposeDeduction(1, DEDUCTION, EVIDENCE_HASH))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(Status.DeductionProposed, Status.Funded);
    });

    it("is still allowed exactly at the end of the proposal window", async function () {
      const { escrow, landlord, endTime } = await loadFixture(fundedFixture);
      await time.setNextBlockTimestamp(endTime + PROPOSAL_WINDOW);
      await expect(escrow.connect(landlord).proposeDeduction(1, DEDUCTION, EVIDENCE_HASH)).to.emit(escrow, "DeductionProposed");
    });

    it("is rejected one second after the proposal window", async function () {
      const { escrow, landlord, endTime } = await loadFixture(fundedFixture);
      const deadline = endTime + PROPOSAL_WINDOW;
      await time.setNextBlockTimestamp(deadline + 1);
      await expect(escrow.connect(landlord).proposeDeduction(1, DEDUCTION, EVIDENCE_HASH))
        .to.be.revertedWithCustomError(escrow, "ProposalWindowClosed")
        .withArgs(deadline);
    });
  });

  describe("acceptDeduction", function () {
    it("settles immediately with the proposed split", async function () {
      const { escrow, tenant, landlord } = await loadFixture(proposedFixture);

      await expect(escrow.connect(tenant).acceptDeduction(1))
        .to.emit(escrow, "LeaseSettled")
        .withArgs(1, DEDUCTION, DEPOSIT - DEDUCTION, SType.DeductionAccepted);

      expect(await escrow.pendingWithdrawals(landlord.address)).to.equal(DEDUCTION);
      expect(await escrow.pendingWithdrawals(tenant.address)).to.equal(DEPOSIT - DEDUCTION);
    });

    it("pays each side its share and leaves the contract empty", async function () {
      const { escrow, tenant, landlord } = await loadFixture(proposedFixture);
      await escrow.connect(tenant).acceptDeduction(1);

      await expect(escrow.connect(landlord).withdraw()).to.changeEtherBalances([landlord, escrow], [DEDUCTION, -DEDUCTION]);
      await expect(escrow.connect(tenant).withdraw()).to.changeEtherBalances(
        [tenant, escrow],
        [DEPOSIT - DEDUCTION, -(DEPOSIT - DEDUCTION)]
      );
      expect(await ethers.provider.getBalance(escrow.target)).to.equal(0);
    });

    it("cannot be called by the landlord or a stranger", async function () {
      const { escrow, landlord, stranger } = await loadFixture(proposedFixture);
      await expect(escrow.connect(landlord).acceptDeduction(1)).to.be.revertedWithCustomError(escrow, "NotTenant");
      await expect(escrow.connect(stranger).acceptDeduction(1)).to.be.revertedWithCustomError(escrow, "NotTenant");
    });

    it("is impossible when nothing has been proposed", async function () {
      const { escrow, tenant } = await loadFixture(endedFixture);
      await expect(escrow.connect(tenant).acceptDeduction(1))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(Status.Funded, Status.DeductionProposed);
    });
  });

  describe("rejectDeduction", function () {
    it("moves the lease to Disputed and emits DeductionRejected", async function () {
      const { escrow, tenant } = await loadFixture(proposedFixture);
      await expect(escrow.connect(tenant).rejectDeduction(1)).to.emit(escrow, "DeductionRejected").withArgs(1, tenant.address);
      expect((await escrow.getLease(1)).status).to.equal(Status.Disputed);
    });

    it("keeps the money frozen while disputed", async function () {
      const { escrow, tenant, landlord } = await loadFixture(disputedFixture);
      expect(await ethers.provider.getBalance(escrow.target)).to.equal(DEPOSIT);
      await expect(escrow.connect(tenant).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
      await expect(escrow.connect(landlord).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
    });

    it("is rejected for anyone but the tenant", async function () {
      const { escrow, landlord, stranger } = await loadFixture(proposedFixture);
      await expect(escrow.connect(landlord).rejectDeduction(1)).to.be.revertedWithCustomError(escrow, "NotTenant");
      await expect(escrow.connect(stranger).rejectDeduction(1)).to.be.revertedWithCustomError(escrow, "NotTenant");
    });

    it("is still allowed exactly at the end of the response window", async function () {
      const { escrow, tenant, proposedAt } = await loadFixture(proposedFixture);
      await time.setNextBlockTimestamp(proposedAt + RESPONSE_WINDOW);
      await expect(escrow.connect(tenant).rejectDeduction(1)).to.emit(escrow, "DeductionRejected");
    });

    it("is too late one second after the response window (silence counts as consent)", async function () {
      const { escrow, tenant, proposedAt } = await loadFixture(proposedFixture);
      const deadline = proposedAt + RESPONSE_WINDOW;
      await time.setNextBlockTimestamp(deadline + 1);
      await expect(escrow.connect(tenant).rejectDeduction(1))
        .to.be.revertedWithCustomError(escrow, "ResponseWindowClosed")
        .withArgs(deadline);
    });

    it("blocks accepting once the dispute has started", async function () {
      const { escrow, tenant } = await loadFixture(disputedFixture);
      await expect(escrow.connect(tenant).acceptDeduction(1))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(Status.Disputed, Status.DeductionProposed);
    });
  });

  describe("resolveDispute (arbiter)", function () {
    it("can only be called by the arbiter", async function () {
      const { escrow, landlord, tenant, stranger } = await loadFixture(disputedFixture);
      for (const who of [landlord, tenant, stranger]) {
        await expect(escrow.connect(who).resolveDispute(1, DEDUCTION)).to.be.revertedWithCustomError(escrow, "NotArbiter");
      }
    });

    it("cannot award the landlord more than he claimed", async function () {
      const { escrow, arbiter } = await loadFixture(disputedFixture);
      await expect(escrow.connect(arbiter).resolveDispute(1, DEDUCTION + 1n))
        .to.be.revertedWithCustomError(escrow, "AwardExceedsClaim")
        .withArgs(DEDUCTION, DEDUCTION + 1n);
    });

    it("splits the deposit as ruled (partial award)", async function () {
      const { escrow, arbiter, landlord, tenant } = await loadFixture(disputedFixture);
      const award = DEDUCTION / 2n;

      await expect(escrow.connect(arbiter).resolveDispute(1, award))
        .to.emit(escrow, "LeaseSettled")
        .withArgs(1, award, DEPOSIT - award, SType.Arbitrated);

      expect(await escrow.pendingWithdrawals(landlord.address)).to.equal(award);
      expect(await escrow.pendingWithdrawals(tenant.address)).to.equal(DEPOSIT - award);
      expect((await escrow.getLease(1)).status).to.equal(Status.Settled);
    });

    it("can rule fully for the tenant (award zero)", async function () {
      const { escrow, arbiter, landlord, tenant } = await loadFixture(disputedFixture);
      await escrow.connect(arbiter).resolveDispute(1, 0);
      expect(await escrow.pendingWithdrawals(landlord.address)).to.equal(0);
      expect(await escrow.pendingWithdrawals(tenant.address)).to.equal(DEPOSIT);
    });

    it("can rule fully for the landlord's claim", async function () {
      const { escrow, arbiter, landlord, tenant } = await loadFixture(disputedFixture);
      await escrow.connect(arbiter).resolveDispute(1, DEDUCTION);
      expect(await escrow.pendingWithdrawals(landlord.address)).to.equal(DEDUCTION);
      expect(await escrow.pendingWithdrawals(tenant.address)).to.equal(DEPOSIT - DEDUCTION);
    });

    it("is only possible while disputed, and only once", async function () {
      const { escrow, arbiter } = await loadFixture(proposedFixture);
      await expect(escrow.connect(arbiter).resolveDispute(1, 0))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(Status.DeductionProposed, Status.Disputed);
    });

    it("cannot be repeated after settlement", async function () {
      const { escrow, arbiter } = await loadFixture(disputedFixture);
      await escrow.connect(arbiter).resolveDispute(1, 0);
      await expect(escrow.connect(arbiter).resolveDispute(1, 0))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(Status.Settled, Status.Disputed);
    });
  });

  describe("claimByTimeout (default rules for silence)", function () {
    it("rejects an early call while the lease is still running", async function () {
      const { escrow, stranger, endTime } = await loadFixture(fundedFixture);
      await expect(escrow.connect(stranger).claimByTimeout(1))
        .to.be.revertedWithCustomError(escrow, "TimeoutNotReached")
        .withArgs(endTime + PROPOSAL_WINDOW);
    });

    it("refuses exactly at the proposal deadline", async function () {
      const { escrow, stranger, endTime } = await loadFixture(fundedFixture);
      const deadline = endTime + PROPOSAL_WINDOW;
      await time.setNextBlockTimestamp(deadline);
      await expect(escrow.connect(stranger).claimByTimeout(1))
        .to.be.revertedWithCustomError(escrow, "TimeoutNotReached")
        .withArgs(deadline);
    });

    it("refunds the tenant in full when the landlord stays silent", async function () {
      const { escrow, tenant, stranger, endTime } = await loadFixture(fundedFixture);
      await time.setNextBlockTimestamp(endTime + PROPOSAL_WINDOW + 1);

      // anyone can trigger it; the outcome is fixed by the stored terms
      await expect(escrow.connect(stranger).claimByTimeout(1))
        .to.emit(escrow, "LeaseSettled")
        .withArgs(1, 0, DEPOSIT, SType.FullRefundByTimeout);

      expect(await escrow.pendingWithdrawals(tenant.address)).to.equal(DEPOSIT);
      await expect(escrow.connect(tenant).withdraw()).to.changeEtherBalances([tenant, escrow], [DEPOSIT, -DEPOSIT]);
    });

    it("applies the deduction when the tenant stays silent", async function () {
      const { escrow, landlord, tenant, stranger, proposedAt } = await loadFixture(proposedFixture);
      await time.setNextBlockTimestamp(proposedAt + RESPONSE_WINDOW + 1);

      await expect(escrow.connect(stranger).claimByTimeout(1))
        .to.emit(escrow, "LeaseSettled")
        .withArgs(1, DEDUCTION, DEPOSIT - DEDUCTION, SType.DeductionBySilence);

      expect(await escrow.pendingWithdrawals(landlord.address)).to.equal(DEDUCTION);
      expect(await escrow.pendingWithdrawals(tenant.address)).to.equal(DEPOSIT - DEDUCTION);
    });

    it("refuses before the response deadline and exactly at it", async function () {
      const { escrow, stranger, proposedAt } = await loadFixture(proposedFixture);
      const deadline = proposedAt + RESPONSE_WINDOW;
      await expect(escrow.connect(stranger).claimByTimeout(1))
        .to.be.revertedWithCustomError(escrow, "TimeoutNotReached")
        .withArgs(deadline);
      await time.setNextBlockTimestamp(deadline);
      await expect(escrow.connect(stranger).claimByTimeout(1))
        .to.be.revertedWithCustomError(escrow, "TimeoutNotReached")
        .withArgs(deadline);
    });

    it("does nothing for a disputed lease (only the arbiter can settle it)", async function () {
      const { escrow, stranger, proposedAt } = await loadFixture(disputedFixture);
      await time.increaseTo(proposedAt + RESPONSE_WINDOW + 10 * DAY);
      await expect(escrow.connect(stranger).claimByTimeout(1))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(Status.Disputed, Status.Funded);
    });

    it("does nothing for an unfunded or unknown lease", async function () {
      const created = await loadFixture(createdFixture);
      await expect(created.escrow.connect(created.stranger).claimByTimeout(1)).to.be.revertedWithCustomError(
        created.escrow,
        "InvalidStatus"
      );
      await expect(created.escrow.connect(created.stranger).claimByTimeout(42))
        .to.be.revertedWithCustomError(created.escrow, "LeaseNotFound")
        .withArgs(42);
    });

    it("cannot settle a lease twice", async function () {
      const { escrow, landlord, stranger, endTime } = await loadFixture(fundedFixture);
      await time.setNextBlockTimestamp(endTime + PROPOSAL_WINDOW + 1);
      await escrow.connect(stranger).claimByTimeout(1);
      await expect(escrow.connect(stranger).claimByTimeout(1))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus")
        .withArgs(Status.Settled, Status.Funded);
      await expect(escrow.connect(landlord).releaseDeposit(1)).to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });
  });

  describe("withdraw (pull payment)", function () {
    it("reverts when nothing is owed", async function () {
      const { escrow, stranger } = await loadFixture(deployFixture);
      await expect(escrow.connect(stranger).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
    });

    it("emits Withdrawn and cannot be repeated", async function () {
      const { escrow, landlord, tenant } = await loadFixture(endedFixture);
      await escrow.connect(landlord).releaseDeposit(1);

      await expect(escrow.connect(tenant).withdraw()).to.emit(escrow, "Withdrawn").withArgs(tenant.address, DEPOSIT);
      expect(await escrow.pendingWithdrawals(tenant.address)).to.equal(0);
      await expect(escrow.connect(tenant).withdraw()).to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
    });

    it("lets the landlord collect credits from several leases in one withdrawal", async function () {
      const { escrow, landlord, tenant, other } = await loadFixture(fundedFixture);

      // second lease, other tenant
      const terms2 = await makeTerms(other.address);
      await escrow.connect(landlord).createLease(terms2);
      await escrow.connect(other).payDeposit(2, REPORT_HASH, { value: DEPOSIT });

      await time.increaseTo(terms2.endTime); // both leases have now ended
      await escrow.connect(landlord).proposeDeduction(1, DEDUCTION, EVIDENCE_HASH);
      await escrow.connect(landlord).proposeDeduction(2, DEDUCTION, EVIDENCE_HASH);
      await escrow.connect(tenant).acceptDeduction(1);
      await escrow.connect(other).acceptDeduction(2);

      expect(await escrow.pendingWithdrawals(landlord.address)).to.equal(2n * DEDUCTION);
      await expect(escrow.connect(landlord).withdraw()).to.changeEtherBalances(
        [landlord, escrow],
        [2n * DEDUCTION, -2n * DEDUCTION]
      );
    });

    it("keeps contract balance equal to unpaid credits plus locked deposits", async function () {
      const { escrow, landlord, tenant, other } = await loadFixture(fundedFixture);
      const terms2 = await makeTerms(other.address);
      await escrow.connect(landlord).createLease(terms2);
      await escrow.connect(other).payDeposit(2, REPORT_HASH, { value: DEPOSIT });
      await time.increaseTo(terms2.endTime);

      // lease 1 settled with a deduction, lease 2 still locked
      await escrow.connect(landlord).proposeDeduction(1, DEDUCTION, EVIDENCE_HASH);
      await escrow.connect(tenant).acceptDeduction(1);
      await escrow.connect(tenant).withdraw(); // tenant takes his part of lease 1

      const pending = (await escrow.pendingWithdrawals(landlord.address)) + (await escrow.pendingWithdrawals(tenant.address));
      const lockedLease2 = DEPOSIT;
      expect(await ethers.provider.getBalance(escrow.target)).to.equal(pending + lockedLease2);
    });
  });

  describe("reentrancy protection", function () {
    it("a malicious tenant contract cannot drain other users' deposits", async function () {
      const { escrow, landlord, other, stranger } = await loadFixture(deployFixture);

      const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
      const attacker = await Attacker.deploy(escrow.target);
      await attacker.waitForDeployment();

      // lease 1: tenant is the attacker contract; lease 2: an honest tenant (the "bait")
      await escrow.connect(landlord).createLease(await makeTerms(attacker.target));
      const terms2 = await makeTerms(other.address);
      await escrow.connect(landlord).createLease(terms2);

      await attacker.connect(stranger).payDeposit(1, REPORT_HASH, { value: DEPOSIT });
      await escrow.connect(other).payDeposit(2, REPORT_HASH, { value: DEPOSIT });

      await time.increaseTo(terms2.endTime);
      await escrow.connect(landlord).releaseDeposit(1); // credits the attacker with its own deposit

      await attacker.attack();

      // it received exactly its own deposit, the re-entry attempt failed, and the bait is intact
      expect(await ethers.provider.getBalance(attacker.target)).to.equal(DEPOSIT);
      expect(await attacker.reentryAttempts()).to.equal(1);
      expect(await attacker.reentrySuccesses()).to.equal(0);
      expect(await ethers.provider.getBalance(escrow.target)).to.equal(DEPOSIT);
      expect(await escrow.pendingWithdrawals(attacker.target)).to.equal(0);
    });
  });
});

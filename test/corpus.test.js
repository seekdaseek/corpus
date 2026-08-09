const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const { JsonRpcProvider, ContractFactory, verifyMessage, parseEther } = require("ethers");
const { appraise, signReport, sha256 } = require("../appraiser/appraise");

const ART = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", `${n}.json`), "utf8"));
const FIX = (f) => path.join(__dirname, "..", "appraiser", "fixtures", f);

describe("corpus", function () {
  this.timeout(60000);
  let provider, admin, creator, buyer, buyer2, treasury, appraiserWallet;
  let vault, anvil;

  // Revert assertions go through raw eth_call at explicit "latest" with
  // hand-encoded calldata, matched by 4-byte custom-error selector.
  // Rationale (found the hard way): ethers v6's contract estimateGas path can
  // serve a stale revert answer for a repeated identical call; the node itself
  // answers correctly on raw eth_call at every block tag.
  async function expectRevert(target, signer, fn, args, name, value) {
    const data = target.interface.encodeFunctionData(fn, args);
    const call = { from: await signer.getAddress(), to: await target.getAddress(), data };
    if (value !== undefined) call.value = "0x" + value.toString(16);
    try {
      await provider.send("eth_call", [call, "latest"]);
    } catch (e) {
      const d = e?.error?.data ?? e?.info?.error?.data ?? e?.data;
      const err = vault.interface.getError(name);
      if (!err) throw new Error("unknown error name in ABI: " + name);
      expect(typeof d === "string" ? d.slice(0, 10) : d).to.equal(err.selector, "expected " + name);
      return;
    }
    throw new Error("expected revert " + name + " but eth_call succeeded");
  }

  async function mine(seconds) {
    await provider.send("evm_increaseTime", [seconds]);
    await provider.send("evm_mine", []);
  }

  before(async () => {
    try { execSync("pkill -f 'anvil --port 8600' || true"); } catch {}
    anvil = spawn("anvil", ["--port", "8600", "--silent"], { stdio: "ignore" });
    provider = new JsonRpcProvider("http://127.0.0.1:8600", undefined, { staticNetwork: true, pollingInterval: 50, cacheTimeout: -1 });
    for (let i = 0; i < 100; i++) {
      try { await provider.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const signers = [];
    for (let i = 0; i < 6; i++) signers.push(await provider.getSigner(i));
    [admin, creator, buyer, buyer2, treasury, appraiserWallet] = signers;
    const a = ART("CorpusVault");
    const f = new ContractFactory(a.abi, a.bytecode, admin);
    vault = await f.deploy(await admin.getAddress(), await treasury.getAddress(), 500); // 5% fee
    await vault.waitForDeployment();
    const role = await vault.APPRAISER_ROLE();
    await (await vault.grantRole(role, await appraiserWallet.getAddress())).wait();
  });

  describe("appraiser engine", () => {
    it("passes the good epoch with a full score and no refusal", () => {
      const r = appraise(FIX("manifest_good.json"));
      expect(r.refusal).to.equal(false);
      expect(r.scoreBps).to.equal(10000);
      expect(r.checks.filter((c) => !c.ok)).to.have.length(0);
    });
    it("refuses the corrupted epoch on hard failures (schema + row count)", () => {
      const r = appraise(FIX("manifest_bad.json"));
      expect(r.refusal).to.equal(true);
      expect(r.scoreBps).to.equal(0);
      const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
      expect(failed).to.include("schema");
      expect(failed).to.include("row_count");
    });
    it("produces a verifiable EIP-191 signature over the report hash", async () => {
      const r = appraise(FIX("manifest_good.json"));
      const pk = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
      const signed = await signReport(r, pk);
      expect(verifyMessage(signed.reportHash, signed.signature)).to.equal(signed.signer);
      expect(signed.reportHash).to.equal(sha256(Buffer.from(signed.body)));
    });
  });

  describe("CorpusVault contract", () => {
    let id;
    const contentHash = "0x" + "11".repeat(32);
    const price = parseEther("1");
    const DAY = 86400;

    it("creates a vault, mints the NFT to the creator, stores fields", async () => {
      await (await vault.connect(creator).createVault(contentHash, "ipfs://manifest1", price, 7 * DAY)).wait();
      id = await vault.nextVaultId();
      expect(id).to.equal(1n);
      expect(await vault.ownerOf(id)).to.equal(await creator.getAddress());
      const v = await vault.vaults(id);
      expect(v.contentHash).to.equal(contentHash);
      expect(v.priceWei).to.equal(price);
      expect(v.listed).to.equal(true);
    });

    it("rejects zero price and zero duration at creation", async () => {
      await expectRevert(vault, creator, "createVault", [contentHash, "x", 0, DAY], "ZeroPrice");
      await expectRevert(vault, creator, "createVault", [contentHash, "x", price, 0], "ZeroDuration");
    });

    it("blocks purchase before any appraisal exists", async () => {
      await expectRevert(vault, buyer, "buyLicense", [id], "NotAppraised", price);
    });

    it("only APPRAISER_ROLE can post an appraisal", async () => {
      await expectRevert(vault, buyer, "setAppraisal", [id, 9000, "0x" + "22".repeat(32), "u", false], "AccessControlUnauthorizedAccount");
    });

    it("appraiser posts a refusal report; buy stays blocked with AppraisalRefused", async () => {
      await (await vault.connect(appraiserWallet).setAppraisal(id, 0, "0x" + "22".repeat(32), "ipfs://refused", true)).wait();
      const ap = await vault.appraisals(id);
      expect(ap.exists).to.equal(true);
      expect(ap.refusal).to.equal(true);
      await expectRevert(vault, buyer, "buyLicense", [id], "AppraisalRefused", price);
    });

    it("clean appraisal unblocks the sale; exact payment enforced", async () => {
      await (await vault.connect(appraiserWallet).setAppraisal(id, 9700, "0x" + "33".repeat(32), "ipfs://report1", false)).wait();
      await expectRevert(vault, buyer, "buyLicense", [id], "WrongPayment", price - 1n);
      await (await vault.connect(buyer).buyLicense(id, { value: price })).wait();
      expect(await vault.hasAccess(id, await buyer.getAddress())).to.equal(true);
    });

    it("splits revenue 95/5 into pull balances (no push transfers)", async () => {
      expect(await vault.balances(await creator.getAddress())).to.equal((price * 9500n) / 10000n);
      expect(await vault.balances(await treasury.getAddress())).to.equal((price * 500n) / 10000n);
    });

    it("caps scoreBps at 10000", async () => {
      await (await vault.connect(appraiserWallet).setAppraisal(id, 60000, "0x" + "44".repeat(32), "u", false)).wait();
      const ap = await vault.appraisals(id);
      expect(ap.scoreBps).to.equal(10000n);
    });

    it("license expires after its duration", async () => {
      await mine(7 * DAY + 10);
      expect(await vault.hasAccess(id, await buyer.getAddress())).to.equal(false);
    });

    it("re-purchase extends from now; back-to-back purchases stack", async () => {
      await (await vault.connect(buyer).buyLicense(id, { value: price })).wait();
      await (await vault.connect(buyer).buyLicense(id, { value: price })).wait();
      const exp = await vault.licenseExpiry(id, await buyer.getAddress());
      const block = await provider.getBlock("latest");
      const delta = Number(exp) - block.timestamp;
      expect(delta).to.be.greaterThan(13 * DAY);
      expect(delta).to.be.at.most(14 * DAY + 5);
    });

    it("vault owner always has access without a license", async () => {
      expect(await vault.hasAccess(id, await creator.getAddress())).to.equal(true);
    });

    it("only the vault owner can change listing/price; zero price rejected", async () => {
      await expectRevert(vault, buyer, "setListing", [id, false, price], "NotVaultOwner");
      await expectRevert(vault, creator, "setListing", [id, true, 0], "ZeroPrice");
      await (await vault.connect(creator).setListing(id, false, price)).wait();
      await expectRevert(vault, buyer2, "buyLicense", [id], "NotListed", price);
      await (await vault.connect(creator).setListing(id, true, price)).wait();
    });

    it("withdraw pays out and zeroes the balance; empty withdraw reverts", async () => {
      const before = await provider.getBalance(await treasury.getAddress());
      await (await vault.connect(treasury).withdraw()).wait();
      const after = await provider.getBalance(await treasury.getAddress());
      expect(after > before).to.equal(true);
      expect(await vault.balances(await treasury.getAddress())).to.equal(0n);
      await expectRevert(vault, treasury, "withdraw", [], "NothingToWithdraw");
    });

    it("NFT transfer moves control and future revenue to the new owner", async () => {
      await (
        await vault.connect(creator)["safeTransferFrom(address,address,uint256)"](
          await creator.getAddress(), await buyer2.getAddress(), id
        )
      ).wait();
      const prev = await vault.balances(await buyer2.getAddress());
      await (await vault.connect(buyer).buyLicense(id, { value: price })).wait();
      expect((await vault.balances(await buyer2.getAddress())) - prev).to.equal((price * 9500n) / 10000n);
      await (await vault.connect(buyer2).setListing(id, true, price)).wait();
    });

    it("admin fee controls: cap enforced, only admin", async () => {
      await expectRevert(vault, creator, "setProtocolFee", [100], "AccessControlUnauthorizedAccount");
      await expectRevert(vault, admin, "setProtocolFee", [2001], "FeeTooHigh");
      await (await vault.connect(admin).setProtocolFee(300)).wait();
      expect(await vault.protocolFeeBps()).to.equal(300n);
      await (await vault.connect(admin).setProtocolFee(500)).wait();
    });

    it("appraising a nonexistent vault reverts", async () => {
      await expectRevert(vault, appraiserWallet, "setAppraisal", [999, 1, "0x" + "55".repeat(32), "u", false], "ERC721NonexistentToken");
    });

    it("reentrancy: malicious creator cannot re-enter withdraw; funds stay credited, clean pull succeeds", async () => {
      const s = ART("ReentrantSink");
      const sinkF = new ContractFactory(s.abi, s.bytecode, admin);
      const sink = await sinkF.deploy(await vault.getAddress());
      await sink.waitForDeployment();
      await (await sink.create("0x" + "66".repeat(32), "ipfs://m2", price, DAY)).wait();
      const sid = await vault.nextVaultId();
      await (await vault.connect(appraiserWallet).setAppraisal(sid, 8000, "0x" + "77".repeat(32), "u", false)).wait();
      await (await vault.connect(buyer).buyLicense(sid, { value: price })).wait();
      const credited = await vault.balances(await sink.getAddress());
      expect(credited).to.equal((price * 9500n) / 10000n);
      await (await sink.setAttack(true)).wait();
      await expectRevert(sink, admin, "pull", [], "TransferFailed");
      expect(await vault.balances(await sink.getAddress())).to.equal(credited);
      await (await sink.setAttack(false)).wait();
      await (await sink.pull()).wait();
      expect(await vault.balances(await sink.getAddress())).to.equal(0n);
      expect(await provider.getBalance(await sink.getAddress())).to.equal(credited);
    });

    it("appraisal history timestamp is recorded", async () => {
      const ap = await vault.appraisals(id);
      expect(ap.appraisedAt > 0n).to.equal(true);
      expect(ap.exists).to.equal(true);
    });
  });

  after(async () => {
    provider.destroy();
    anvil.kill();
  });
});

import { expect } from "chai";
import { ethers } from "hardhat";
import { BaseMailRegistry } from "../typechain-types";

describe("BaseMailRegistry", function () {
  let registry: BaseMailRegistry;
  let owner: any;
  let agent1: any;
  let agent2: any;

  beforeEach(async function () {
    [owner, agent1, agent2] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("BaseMailRegistry");
    registry = await Factory.deploy();
  });

  describe("Registration", function () {
    it("should register a valid handle", async function () {
      await expect(registry.connect(agent1).register("myagent"))
        .to.emit(registry, "EmailRegistered")
        .withArgs(agent1.address, "myagent", "myagent@basemail.ai");

      expect(await registry.emailOf(agent1.address)).to.equal("myagent");
      expect(await registry.ownerOf("myagent")).to.equal(agent1.address);
      expect(await registry.taken("myagent")).to.be.true;
      expect(await registry.totalRegistrations()).to.equal(1);
    });

    it("should reject duplicate handles", async function () {
      await registry.connect(agent1).register("myagent");
      await expect(
        registry.connect(agent2).register("myagent")
      ).to.be.revertedWith("Handle already taken");
    });

    it("should reject duplicate wallet registration", async function () {
      await registry.connect(agent1).register("myagent");
      await expect(
        registry.connect(agent1).register("otheragent")
      ).to.be.revertedWith("Wallet already registered");
    });

    it("should reject invalid handles", async function () {
      // 太短
      await expect(registry.connect(agent1).register("ab"))
        .to.be.revertedWith("Invalid handle format");

      // 以 - 開頭
      await expect(registry.connect(agent1).register("-bad"))
        .to.be.revertedWith("Invalid handle format");

      // 以 _ 結尾
      await expect(registry.connect(agent1).register("bad_"))
        .to.be.revertedWith("Invalid handle format");

      // 含大寫
      await expect(registry.connect(agent1).register("BadName"))
        .to.be.revertedWith("Invalid handle format");
    });

    it("should accept handles with hyphens and underscores", async function () {
      await registry.connect(agent1).register("my-agent_01");
      expect(await registry.emailOf(agent1.address)).to.equal("my-agent_01");
    });
  });

  describe("Query", function () {
    it("should return full email address", async function () {
      await registry.connect(agent1).register("myagent");
      expect(await registry.getEmail(agent1.address)).to.equal("myagent@basemail.ai");
    });

    it("should check availability", async function () {
      expect(await registry.isAvailable("myagent")).to.be.true;
      await registry.connect(agent1).register("myagent");
      expect(await registry.isAvailable("myagent")).to.be.false;
    });
  });

  describe("Transfer", function () {
    it("should transfer handle to another wallet", async function () {
      await registry.connect(agent1).register("myagent");
      await expect(registry.connect(agent1).transfer("myagent", agent2.address))
        .to.emit(registry, "EmailTransferred")
        .withArgs("myagent", agent1.address, agent2.address);

      expect(await registry.emailOf(agent2.address)).to.equal("myagent");
      expect(await registry.ownerOf("myagent")).to.equal(agent2.address);
    });

    it("should reject transfer by non-owner", async function () {
      await registry.connect(agent1).register("myagent");
      await expect(
        registry.connect(agent2).transfer("myagent", agent2.address)
      ).to.be.revertedWith("Not handle owner");
    });
  });

  describe("Release", function () {
    it("should release a handle", async function () {
      await registry.connect(agent1).register("myagent");
      await expect(registry.connect(agent1).release())
        .to.emit(registry, "EmailReleased")
        .withArgs(agent1.address, "myagent");

      expect(await registry.taken("myagent")).to.be.false;
      expect(await registry.totalRegistrations()).to.equal(0);
    });
  });

  describe("Admin", function () {
    it("should pause and unpause", async function () {
      await registry.pause();
      await expect(
        registry.connect(agent1).register("myagent")
      ).to.be.revertedWith("Contract paused");

      await registry.unpause();
      await registry.connect(agent1).register("myagent");
      expect(await registry.emailOf(agent1.address)).to.equal("myagent");
    });
  });
});

import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying BaseMailRegistry with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "ETH");

  const Factory = await ethers.getContractFactory("BaseMailRegistry");
  const registry = await Factory.deploy();
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  console.log("BaseMailRegistry deployed to:", address);
  console.log("");
  console.log("Next steps:");
  console.log(`1. Verify on BaseScan: npx hardhat verify --network <network> ${address}`);
  console.log(`2. Update wrangler.toml: REGISTRY_CONTRACT = "${address}"`);
  console.log(`3. Update CLOUDFLARE_RESOURCES.md with contract address`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

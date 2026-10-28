/** Where a review is paid, and the desk it is paid to. The payee is pinned: the action pays no one else. */
export interface Preset {
  desk: string;
  payTo: `0x${string}`;
  network: `eip155:${number}`;
  asset: `0x${string}`;
  rpc: string;
  chain: string;
  token: string;
  /** Where a task's page lives, when the network has one. */
  taskPage?: (id: string) => string;
  /** Paid through Permit2, which the wallet must approve once. */
  permit2?: true;
}

export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const MAINNET = { desk: "https://brain.usebrainchain.com", payTo: "0xafB0C4Ef895D4895040cdC6435B96D3EE8350c6E" } as const;
const TESTNET = { desk: "https://brain.testnet.usebrainchain.com", payTo: "0xf848984c8A0D9E49Cc9C97380C62b34C6f3b97D1" } as const;

const PRESETS: Record<"mainnet" | "testnet", Record<"base" | "robinhood", Preset>> = {
  mainnet: {
    base: {
      ...MAINNET,
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      rpc: "https://mainnet.base.org",
      chain: "Base",
      token: "USDC",
      taskPage: (id) => `https://usebrainchain.com/task?id=${id}`,
    },
    robinhood: {
      ...MAINNET,
      network: "eip155:4663",
      asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      rpc: "https://rpc.mainnet.chain.robinhood.com",
      chain: "Robinhood Chain",
      token: "USDG",
      permit2: true,
      taskPage: (id) => `https://usebrainchain.com/task?id=${id}`,
    },
  },
  testnet: {
    base: {
      ...TESTNET,
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      rpc: "https://sepolia.base.org",
      chain: "Base Sepolia",
      token: "test USDC",
    },
    robinhood: {
      ...TESTNET,
      network: "eip155:46630",
      asset: "0x1eC185467cA2D5d1c24f0EdCB91301Bca4d0a787",
      rpc: "https://rpc.testnet.chain.robinhood.com",
      chain: "Robinhood Chain testnet",
      token: "test USDG",
      permit2: true,
    },
  },
};

export function preset(network: string, payOn: string): Preset {
  const n = network.trim().toLowerCase();
  const p = payOn.trim().toLowerCase();
  if (n !== "mainnet" && n !== "testnet") throw new Error(`network must be mainnet or testnet, not "${network}".`);
  if (p !== "base" && p !== "robinhood") throw new Error(`pay-on must be base or robinhood, not "${payOn}".`);
  return PRESETS[n][p];
}

/** Tokens use 6 decimals. "1" reads 1000000; "0.5" reads 500000. */
export function units(amount: string): bigint {
  const match = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!match) throw new Error(`max-price must be an amount such as 1 or 2.5, not "${amount}".`);
  const value = BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (value === 0n) throw new Error("max-price must be above zero.");
  return value;
}

export function amount(value: bigint): string {
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${value / 1_000_000n}.${fraction}` : `${value / 1_000_000n}`;
}

// A loopback stand-in for Robinhood Chain (4663) for payment tests and
// fixtures: ERC-20 balances, ETH for fees, raw transaction broadcast, and
// the Transfer logs, receipts and blocks the payment scan reads. A block is
// mined every second from 256, so confirmations arrive on their own.
import { createServer, type Server } from "node:http";
import {
  decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, pad, parseAbi, parseAbiItem,
  parseTransaction, recoverTransactionAddress, toHex, type Hex,
} from "viem";

const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address owner) view returns (uint256)"]);
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export interface FakeTransfer { token: string; from: string; to: string; value: bigint; hash: string; block: bigint; time: bigint }

export interface FakeChain {
  url: string;
  transfers: FakeTransfer[];
  sent: string[];
  calls: string[];
  fund(token: string, owner: string, units: bigint): void;
  fundEth(owner: string, wei: bigint): void;
  balance(token: string, owner: string): bigint;
  /** A transfer from outside (another wallet paying), as if it just landed. */
  transfer(input: { token: string; from: string; to: string; value: bigint; hash?: string }): FakeTransfer;
  close(): Promise<void>;
}

export async function startFakeRobinhoodChain(): Promise<FakeChain> {
  const started = Date.now();
  let extra = 0n;
  const head = () => 256n + BigInt(Math.floor((Date.now() - started) / 1000)) + extra;
  const tokens = new Map<string, Map<string, bigint>>();
  const eth = new Map<string, bigint>();
  const nonces = new Map<string, number>();
  const transfers: FakeTransfer[] = [];
  const sent: string[] = [];
  const calls: string[] = [];
  const holdings = (token: string) => {
    const key = token.toLowerCase();
    if (!tokens.has(key)) tokens.set(key, new Map());
    return tokens.get(key)!;
  };
  const balance = (token: string, owner: string) => holdings(token).get(owner.toLowerCase()) ?? 0n;
  const blockHash = (n: bigint) => pad(toHex(n), { size: 32 });
  const record = (input: { token: string; from: string; to: string; value: bigint; hash?: string }): FakeTransfer => {
    extra += 1n; // its own block
    const transfer = {
      token: input.token.toLowerCase(), from: input.from.toLowerCase(), to: input.to.toLowerCase(), value: input.value,
      hash: (input.hash ?? keccak256(toHex(`${Date.now()}-${Math.random()}`))).toLowerCase(), block: head(), time: BigInt(Math.floor(Date.now() / 1000)),
    };
    transfers.push(transfer);
    return transfer;
  };
  const toLog = (t: FakeTransfer) => ({
    address: t.token,
    topics: encodeEventTopics({ abi: [TRANSFER], eventName: "Transfer", args: { from: t.from as Hex, to: t.to as Hex } }),
    data: encodeAbiParameters([{ type: "uint256" }], [t.value]),
    blockNumber: toHex(t.block), blockHash: blockHash(t.block), transactionHash: t.hash, transactionIndex: "0x0", logIndex: "0x0", removed: false,
  });

  const answer = async (call: { id: unknown; method: string; params?: any[] }) => {
    calls.push(call.method);
    const base = { jsonrpc: "2.0", id: call.id };
    const p = call.params ?? [];
    switch (call.method) {
      case "eth_chainId": return { ...base, result: "0x1237" };
      case "eth_blockNumber": return { ...base, result: toHex(head()) };
      case "eth_getBalance": return { ...base, result: toHex(eth.get(String(p[0]).toLowerCase()) ?? 0n) };
      case "eth_getTransactionCount": return { ...base, result: toHex(nonces.get(String(p[0]).toLowerCase()) ?? 0) };
      case "eth_maxPriorityFeePerGas": return { ...base, result: toHex(1_000_000n) };
      case "eth_gasPrice": return { ...base, result: toHex(11_000_000n) };
      case "eth_estimateGas": return { ...base, result: toHex(52_000n) };
      case "eth_call": {
        const { to, data } = p[0];
        const decoded = decodeFunctionData({ abi: ERC20, data });
        if (decoded.functionName !== "balanceOf") return { ...base, error: { code: -32000, message: "execution reverted" } };
        return { ...base, result: encodeAbiParameters([{ type: "uint256" }], [balance(to, decoded.args[0])]) };
      }
      case "eth_getBlockByNumber": {
        const n = p[0] === "latest" || p[0] === "pending" ? head() : BigInt(p[0]);
        const time = transfers.find((t) => t.block === n)?.time ?? BigInt(Math.floor(Date.now() / 1000));
        return { ...base, result: {
          number: toHex(n), hash: blockHash(n), parentHash: blockHash(n - 1n), timestamp: toHex(time), transactions: [], baseFeePerGas: toHex(10_000_000n),
          gasLimit: "0x1c9c380", gasUsed: "0x0", miner: "0x0000000000000000000000000000000000000000", difficulty: "0x0", extraData: "0x", size: "0x0",
          nonce: "0x0000000000000000", sha3Uncles: blockHash(0n), logsBloom: "0x" + "0".repeat(512), transactionsRoot: blockHash(0n), stateRoot: blockHash(0n), receiptsRoot: blockHash(0n), uncles: [],
        } };
      }
      case "eth_getLogs": {
        const filter = p[0];
        const from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
        const recipient = String(filter.topics?.[2] ?? "").toLowerCase();
        return { ...base, result: transfers.filter((t) => t.token === String(filter.address).toLowerCase() && t.block >= from && t.block <= to
          && (!recipient || pad(t.to as Hex, { size: 32 }).toLowerCase() === recipient)).map(toLog) };
      }
      case "eth_getTransactionReceipt": {
        const t = transfers.find((item) => item.hash === String(p[0]).toLowerCase());
        return { ...base, result: t ? {
          transactionHash: t.hash, blockNumber: toHex(t.block), blockHash: blockHash(t.block), status: "0x1", logs: [toLog(t)], transactionIndex: "0x0",
          from: t.from, to: t.token, cumulativeGasUsed: "0xcb20", gasUsed: "0xcb20", effectiveGasPrice: "0x989680", contractAddress: null, type: "0x2", logsBloom: "0x" + "0".repeat(512),
        } : null };
      }
      case "eth_sendRawTransaction": {
        const raw = String(p[0]) as Hex;
        const tx = parseTransaction(raw);
        const sender = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
        const nonce = nonces.get(sender) ?? 0;
        if (tx.chainId !== 4663) return { ...base, error: { code: -32000, message: "invalid chain id" } };
        if (tx.nonce !== nonce) return { ...base, error: { code: -32000, message: "nonce too low" } };
        const fee = (tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n);
        if ((eth.get(sender) ?? 0n) < fee) return { ...base, error: { code: -32000, message: "insufficient funds for gas" } };
        const call = decodeFunctionData({ abi: ERC20, data: tx.data! });
        if (call.functionName !== "transfer") return { ...base, error: { code: -32000, message: "unsupported" } };
        const [to, value] = call.args;
        if (balance(tx.to!, sender) < value) return { ...base, error: { code: -32000, message: "execution reverted: transfer amount exceeds balance" } };
        nonces.set(sender, nonce + 1);
        eth.set(sender, (eth.get(sender) ?? 0n) - 52_000n * 10_000_000n);
        holdings(tx.to!).set(sender, balance(tx.to!, sender) - value);
        holdings(tx.to!).set(to.toLowerCase(), balance(tx.to!, to) + value);
        const hash = keccak256(raw);
        record({ token: tx.to!, from: sender, to, value, hash });
        sent.push(raw);
        return { ...base, result: hash };
      }
      default: return { ...base, error: { code: -32601, message: `fake chain: ${call.method} is not supported` } };
    }
  };

  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body: unknown;
    try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
    const result = Array.isArray(body) ? await Promise.all(body.map(answer)) : await answer(body as { id: unknown; method: string });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    transfers, sent, calls,
    fund: (token, owner, units) => { holdings(token).set(owner.toLowerCase(), balance(token, owner) + units); },
    fundEth: (owner, wei) => { eth.set(owner.toLowerCase(), (eth.get(owner.toLowerCase()) ?? 0n) + wei); },
    balance,
    transfer: record,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

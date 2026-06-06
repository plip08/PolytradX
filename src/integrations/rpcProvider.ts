import { FallbackProvider, JsonRpcProvider, type Provider } from "ethers";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

export class RpcProviderManager {
  private provider: Provider;

  constructor() {
    const providers = config.rpcUrls.map((url) => new JsonRpcProvider(url));
    this.provider = new FallbackProvider(providers);
  }

  getProvider(): Provider {
    return this.provider;
  }

  async getNetwork(): Promise<string> {
    try {
      const network = await this.provider.getNetwork();
      return `${network.name}:${network.chainId}`;
    } catch (error) {
      logger.warn("RPC provider network query failed, retrying...", error);
      return "unknown";
    }
  }
}

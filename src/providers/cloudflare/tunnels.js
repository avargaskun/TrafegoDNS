/**
 * Cloudflare Tunnel Manager
 * Manages Cloudflare ZeroTrust tunnels
 */
const axios = require('axios');
const logger = require('../../utils/logger');

class CloudflareTunnelManager {
  constructor(config) {
    this.config = config;
    this.client = axios.create({
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${this.config.cloudflareAccountId}`,
      headers: {
        'Authorization': `Bearer ${this.config.cloudflareToken}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async findTunnelByName(tunnelName) {
    try {
      const response = await this.client.get('/cfd_tunnel', {
        params: { name: tunnelName, is_deleted: false },
      });
      return response.data.result[0];
    } catch (error) {
      logger.error(`Failed to find Cloudflare tunnel "${tunnelName}": ${error.message}`);
      return null;
    }
  }

  async updateTunnelIngress(tunnelId, ingressRules) {
    try {
      const response = await this.client.put(`/cfd_tunnel/${tunnelId}/configurations`, {
        config: { ingress: ingressRules },
      });
      return response.data.result;
    } catch (error) {
      logger.error(`Failed to update ingress for tunnel "${tunnelId}": ${error.message}`);
      return null;
    }
  }
}

module.exports = CloudflareTunnelManager;

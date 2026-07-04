import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { BaileysProvider } from '../providers/baileys/BaileysProvider.js';
import type { IMessagingProvider, ProviderState } from '../providers/IMessagingProvider.js';
import { routeMessage } from '../core/intentRouter.js';

/**
 * Owns the messaging provider and wires inbound messages through the intent
 * router back to outbound replies. Phase 1 manages a single linked account but
 * is written so a future multi-tenant version can hold a Map<accountId,
 * provider> without changing the message-handling logic.
 */
class ConnectionManager {
  private provider: IMessagingProvider;
  // Group JID learned from an in-scope inbound message; used for proactive sends.
  private lastGroupJid?: string;

  constructor() {
    this.provider = this.createProvider();
    this.provider.onMessage(async (msg) => {
      const scoped = this.inScope(msg.isGroup, msg.chatId, msg.groupName);
      if (!scoped) {
        logger.info(
          { groupName: msg.groupName, target: env.targetGroupName },
          'message out of scope — ignored',
        );
        return;
      }
      this.lastGroupJid = msg.chatId;
      try {
        const text = await routeMessage(msg);
        if (text) await this.provider.sendText(msg.chatId, text);
      } catch (err: any) {
        logger.error({ err: err.message }, 'message handling failed');
      }
    });
  }

  private createProvider(): IMessagingProvider {
    if (env.provider !== 'baileys') {
      logger.warn(`PROVIDER="${env.provider}" not implemented; using baileys.`);
    }
    const accountId = env.botPhoneNumber || 'default';
    return new BaileysProvider({
      accountId,
      targetGroupName: env.targetGroupName,
      targetGroupJid: env.targetGroupJid,
    });
  }

  /**
   * Act ONLY inside the single configured group. Personal chats/DMs and every
   * other group are ignored — this is a hard safety boundary so the bot never
   * replies in private conversations on the bot's number.
   */
  private inScope(isGroup: boolean, chatId: string, groupName?: string): boolean {
    if (!isGroup) return false; // never respond in DMs / personal chats

    // Prefer an exact JID pin when configured (most reliable).
    if (env.targetGroupJid) return chatId === env.targetGroupJid;

    // Otherwise match the group name exactly, ignoring case and separators so
    // "Mighty-Wing Aviaries" == "Mighty-wing-Aviaries".
    if (env.targetGroupName) {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      return norm(groupName ?? '') === norm(env.targetGroupName);
    }

    // No target configured → do nothing (fail closed, never spam every group).
    return false;
  }

  async connect(phoneNumber?: string): Promise<ProviderState> {
    await this.provider.connect({ phoneNumber: phoneNumber || env.botPhoneNumber || undefined });
    return this.provider.getState();
  }

  async disconnect(): Promise<void> {
    await this.provider.disconnect();
  }

  /** Resolve the target group's JID: explicit pin → cached inbound → live lookup. */
  private async resolveTargetJid(): Promise<string | null> {
    if (env.targetGroupJid) return env.targetGroupJid;
    if (this.lastGroupJid) return this.lastGroupJid;
    if (env.targetGroupName && this.provider.resolveGroupJid) {
      const jid = await this.provider.resolveGroupJid(env.targetGroupName);
      if (jid) this.lastGroupJid = jid;
      return jid;
    }
    return null;
  }

  /** Post a proactive message (e.g. the daily digest) to the configured group. */
  async sendToTargetGroup(text: string): Promise<boolean> {
    const jid = await this.resolveTargetJid();
    if (!jid) {
      logger.warn('sendToTargetGroup: could not resolve target group JID');
      return false;
    }
    try {
      await this.provider.sendText(jid, text);
      return true;
    } catch (err: any) {
      logger.error({ err: err.message }, 'sendToTargetGroup failed');
      return false;
    }
  }

  getState(): ProviderState & { provider: string } {
    return { ...this.provider.getState(), provider: this.provider.name };
  }
}

export const connectionManager = new ConnectionManager();
